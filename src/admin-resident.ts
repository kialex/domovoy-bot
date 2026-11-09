import type { Callback, Env, Message } from './env.ts';
import { getGroup, groupId, isConnected } from './groups.ts';
import { entranceForApartment, roleLabel, validFloor } from './premises.ts';
import { answer, send } from './telegram.ts';
import { apartmentNumber, ukrainianPhone } from './validation.ts';

const roles = ['owner','tenant','family'] as const;
type Role = typeof roles[number];
interface Form {
  kind: 'resident';
  token: string;
  expires: number;
  chat: number;
  step: 'apartment'|'floor'|'phone'|'name'|'role'|'confirm';
  number?: string;
  floor?: number;
  phone?: string;
  name?: string;
  role?: Role;
  newApartment?: boolean;
}

const button = (text: string, callback_data: string) => [{text,callback_data}];

async function readForm(env: Env) {
  const row = await env.HOME_DB.prepare('SELECT collection_input FROM private_chats WHERE user_id=?')
    .bind(env.ADMIN_TELEGRAM_USER_ID).first<{collection_input:string|null}>();
  if(!row?.collection_input)return null;
  const form = JSON.parse(row.collection_input) as Form;
  return form.kind==='resident'?{form,raw:row.collection_input}:null;
}

async function prompt(env: Env, form: Form, text: string) {
  const cancel=button('Скасувати',`ar:cancel:${form.token}`);
  const buttons=form.step==='role'?roles.map(role=>button(roleLabel(role),`ar:role:${form.token}:${role}`)):[];
  if(form.step==='confirm')buttons.push(button(form.newApartment?'Додати квартиру й мешканця':'Додати мешканця',`ar:save:${form.token}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,text,[...buttons,cancel]);
}

async function advance(env: Env, raw: string, form: Form, text: string) {
  const result=await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=? WHERE user_id=? AND collection_input=?')
    .bind(JSON.stringify(form),env.ADMIN_TELEGRAM_USER_ID,raw).run();
  if(result.meta.changes)await prompt(env,form,text);
}

export async function adminResidentCallback(env: Env, q: Callback) {
  if(!q.data?.startsWith('ar:'))return false;
  await answer(env,q.id,'');
  if(String(q.from.id)!==env.ADMIN_TELEGRAM_USER_ID||q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id)return true;
  const [,action,token,value]=q.data.split(':');
  if(action==='start') {
    const chat=groupId(token);
    if(!chat||!isConnected(await getGroup(env,chat)))return true;
    const form: Form={kind:'resident',chat,step:'apartment',token:crypto.randomUUID().slice(0,12),expires:Math.floor(Date.now()/1000)+900};
    await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=? WHERE user_id=?')
      .bind(JSON.stringify(form),q.from.id).run();
    await prompt(env,form,'Напишіть номер квартири.');
    return true;
  }

  const pending=await readForm(env);
  if(!pending||pending.form.token!==token)return true;
  const {form,raw}=pending;
  if(action==='cancel'||form.expires<Math.floor(Date.now()/1000)) {
    const removed=await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=NULL WHERE user_id=? AND collection_input=?')
      .bind(q.from.id,raw).run();
    if(removed.meta.changes)await send(env,q.from.id,action==='cancel'?'Додавання скасовано.':'Час минув. Почніть додавання заново.');
    return true;
  }
  if(action==='role'&&form.step==='role'&&roles.includes(value as Role)) {
    const role=value as Role;
    const apartment=form.newApartment
      ? `Нова квартира ${form.number} · під’їзд ${entranceForApartment(form.number!)} · поверх ${form.floor}`
      : `Квартира ${form.number}`;
    await advance(env,raw,{...form,step:'confirm',role},`${apartment}\n${form.name} · ${roleLabel(role)}\n${form.phone}`);
  }
  if(action==='save'&&form.step==='confirm')await saveResident(env,form,raw,q.from.id);
  return true;
}

export async function adminResidentMessage(env: Env, m: Message) {
  if(m.chat.type!=='private'||String(m.from?.id)!==env.ADMIN_TELEGRAM_USER_ID||!m.text)return false;
  const pending=await readForm(env);
  if(!pending)return false;
  const {form,raw}=pending;
  const value=m.text.trim();
  if(form.expires<Math.floor(Date.now()/1000)) {
    await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=NULL WHERE user_id=? AND collection_input=?')
      .bind(env.ADMIN_TELEGRAM_USER_ID,raw).run();
    await send(env,env.ADMIN_TELEGRAM_USER_ID,'Час минув. Почніть додавання заново.');
    return true;
  }
  if(form.step==='apartment') {
    const number=apartmentNumber(value);
    if(!number)return prompt(env,form,'Напишіть номер квартири, наприклад 25 або 84А.').then(()=>true);
    const premise=await env.HOME_DB.prepare("SELECT id FROM premises WHERE chat_id=? AND kind='apartment' AND number=?")
      .bind(form.chat,number).first();
    if(premise)await advance(env,raw,{...form,number,step:'phone'},'Напишіть номер телефону мешканця.');
    else await advance(env,raw,{...form,number,newApartment:true,step:'floor'},`Квартири ${number} ще немає. Напишіть поверх.`);
  } else if(form.step==='floor') {
    const floor=validFloor('apartment',entranceForApartment(form.number!)!,value);
    if(floor===null)await prompt(env,form,'Перевірте номер поверху й напишіть його ще раз.');
    else await advance(env,raw,{...form,floor,step:'phone'},'Напишіть номер телефону мешканця.');
  } else if(form.step==='phone') {
    const phone=ukrainianPhone(value);
    if(!phone)await prompt(env,form,'Напишіть український номер, наприклад +380671234567.');
    else {
      const existing=await env.HOME_DB.prepare('SELECT name FROM profiles WHERE phone=?').bind(phone).first<{name:string}>();
      if(existing)await advance(env,raw,{...form,phone,name:existing.name,step:'role'},`Знайдено: ${existing.name}. Оберіть роль у квартирі.`);
      else await advance(env,raw,{...form,phone,step:'name'},'Напишіть ім’я та прізвище мешканця.');
    }
  } else if(form.step==='name') {
    if(!value||value.length>100||value.includes('\n'))await prompt(env,form,'Напишіть ім’я та прізвище одним рядком, до 100 символів.');
    else await advance(env,raw,{...form,name:value,step:'role'},'Оберіть роль у квартирі.');
  } else await prompt(env,form,form.step==='role'?'Оберіть роль кнопкою.':'Підтвердьте додавання кнопкою.');
  return true;
}

async function saveResident(env: Env, form: Form, raw: string, uid: number) {
  if(!isConnected(await getGroup(env,form.chat))) {
    await send(env,uid,'Будинок недоступний.');
    return;
  }
  const db=env.HOME_DB;
  const active='EXISTS (SELECT 1 FROM private_chats WHERE user_id=? AND collection_input=?)';
  const apartment="SELECT id FROM premises WHERE chat_id=? AND kind='apartment' AND number=?";
  const number=Number.parseInt(form.number!,10);
  const results=await db.batch([
    db.prepare(`INSERT INTO premises(chat_id,kind,number,business_name,entrance,floor,number_start,number_end)
      SELECT ?,'apartment',?,'',?,?,?,? WHERE ?=1 AND ${active}
      ON CONFLICT(chat_id,kind,number) DO NOTHING`)
      .bind(form.chat,form.number!,entranceForApartment(form.number!),form.floor??null,number,number,Number(!!form.newApartment),uid,raw),
    db.prepare(`INSERT INTO profiles(name,phone) SELECT ?,? WHERE ${active}
      AND EXISTS (${apartment}) AND NOT EXISTS (SELECT 1 FROM profiles WHERE phone=?)`)
      .bind(form.name!,form.phone!,uid,raw,form.chat,form.number!,form.phone!),
    db.prepare(`INSERT INTO memberships(profile_id,user_id,premise_id,role,status,application_token,reviewed_by,reviewed_at)
      SELECT p.id,p.user_id,a.id,?,'approved',?, ?,unixepoch() FROM profiles p JOIN (${apartment}) a
      WHERE p.phone=? AND ${active}
      ON CONFLICT(profile_id,premise_id) DO UPDATE SET role=excluded.role,status='approved',
        application_token=excluded.application_token,reviewed_by=excluded.reviewed_by,
        reviewed_at=excluded.reviewed_at,version=memberships.version+1
      WHERE memberships.status!='approved'`)
      .bind(form.role!,crypto.randomUUID(),uid,form.chat,form.number!,form.phone!,uid,raw),
    db.prepare('UPDATE private_chats SET collection_input=NULL WHERE user_id=? AND collection_input=?').bind(uid,raw),
  ]);
  if(!results[3].meta.changes)return;
  const saved=await db.prepare(apartment).bind(form.chat,form.number!).first<{id:number}>();
  await send(env,uid,results[2].meta.changes?`Мешканця додано до квартири ${form.number}.`
    :saved?'Мешканець уже прив’язаний до цієї квартири.':'Квартира недоступна.',
    saved?[button('Відкрити квартиру',`directory:open:${saved.id}`)]:[]);
}
