import { resolveJoin } from './join-requests.ts';
import type { Button, Callback, Env, Message } from './env.ts';
import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import { answer, send, sendHtml, telegram } from './telegram.ts';
import { escapeHtml } from './presentation.ts';
import { apartmentNumber, positiveId, ukrainianPhone } from './validation.ts';
import { commercialKey, entranceForApartment, membershipSelect, premiseLabel, roleLabel, validFloor } from './premises.ts';
import type { Membership, Premise } from './premises.ts';

interface Form {
  kind?: 'apartment' | 'commercial'; number?: string; business_name?: string; entrance?: number; floor?: number;
  ask_name?: boolean; ask_phone?: boolean; name?: string; phone?: string; role?: 'owner' | 'tenant' | 'family'; poll_id?: number;
}
interface Session { user_id: number; chat_id: number; token: string; step: string; data: string }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const sequence = (f: Form) => ['kind', ...(f.kind === 'commercial' ? ['business_name'] : ['number','floor']),
  ...(f.ask_name !== false ? ['name'] : []), ...(f.ask_phone !== false ? ['phone'] : []), 'role','review'];
async function contactDefaults(env: Env, uid: number): Promise<Partial<Form>> {
  const profile = await env.HOME_DB.prepare('SELECT name,phone FROM profiles WHERE user_id=?').bind(uid).first<{name:string;phone:string}>();
  const name = profile?.name?.trim(); const phone = ukrainianPhone(profile?.phone || '');
  return { ask_name: !name || name.length < 2, ask_phone: !phone, ...(name && name.length >= 2 ? {name} : {}), ...(phone ? {phone} : {}) };
}
function firstIncomplete(f: Form): string {
  if (!f.kind) return 'kind';
  if (f.kind === 'commercial') { if (!f.business_name) return 'business_name'; }
  else { if (!f.number) return 'number'; if (f.floor === undefined) return 'floor'; }
  if (!f.name) return 'name'; if (!ukrainianPhone(f.phone || '')) return 'phone';
  return f.role ? 'review' : 'role';
}
async function normalizeSession(env: Env, s: Session): Promise<Session> {
  const f = JSON.parse(s.data) as Form;
  if (f.ask_name === undefined || f.ask_phone === undefined) Object.assign(f, await contactDefaults(env,s.user_id));
  if (f.kind === 'commercial') {
    delete f.entrance; delete f.floor;
    if (f.business_name) f.number = commercialKey(f.business_name); else delete f.number;
  }
  const step = sequence(f).includes(s.step) ? s.step : firstIncomplete(f);
  const data = JSON.stringify(f);
  if (data !== s.data || step !== s.step) await env.HOME_DB.prepare('UPDATE sessions SET step=?,data=? WHERE user_id=? AND token=?').bind(step,data,s.user_id,s.token).run();
  return {...s,step,data};
}
async function registrationNotice(env:Env,q:Callback,text:string) {
  await answer(env,q.id,'');
  if(q.message?.chat.type==='private'&&q.message.chat.id===q.from.id)await plainCard(env,q.from.id,text);
}
const cancel = (s: Session): Button[] => [{ text: 'Скасувати', callback_data: `reg:cancel:${s.token}` }];
function plainCard(env: Env, uid: number | string, text: string, buttons?: Button[][]) {
  const [heading,...rest] = text.split('\n');
  if(!rest.length)return send(env,uid,heading,buttons);
  return sendHtml(env, uid, `<b>${escapeHtml(heading)}</b>\n${escapeHtml(rest.join('\n'))}`, buttons);
}
function description(f: Form) {
  const property = f.kind === 'commercial' ? `🏪 ${f.business_name}` : `🏠 Квартира ${f.number}\nПід’їзд: ${f.entrance} · Поверх: ${f.floor}`;
  return `${property}\n\n👤 ${f.name}\n📱 ${f.phone}\n🔑 ${roleLabel(f.role || '')}`;
}
async function returnToRegistrationPoll(env:Env,uid:number,chatId:number,f:Form) {
  if(!f.poll_id)return;
  const poll=await env.HOME_DB.prepare("SELECT chat_id,message_id,status,ends_at FROM polls WHERE id=? AND chat_id=? AND status IN ('open','closed')").bind(f.poll_id,chatId).first<{chat_id:number;message_id:number|null;status:string;ends_at:number|null}>();
  if(!poll?.message_id||!isConnected(await getGroup(env,chatId)))return;
  const {pollLink}=await import('./resident-menu.ts');const url=pollLink(chatId,poll.message_id);
  if(!url)return;
  const open=poll.status==='open'&&(poll.ends_at===null||poll.ends_at>Math.floor(Date.now()/1000));
  await send(env,uid,open?'Тепер можна проголосувати.':'Це голосування вже завершено.',[[{text:open?'↗️ Повернутися до голосування':'Переглянути результати',url}]]);
}
async function showForm(env: Env, s: Session) {
  const f = JSON.parse(s.data) as Form;
  const group = await getGroup(env, s.chat_id);
  if (!isConnected(group)) return plainCard(env, s.user_id, 'Групу від’єднано\nПочніть реєстрацію з підключеної групи.', [cancel(s)]);
  if (s.step === 'review') return plainCard(env, s.user_id, `📋 Перевірте заявку\n🏘 ${group.title}\n\n${description(f)}\n\nНадсилаючи заявку, ви погоджуєтесь: ім’я та роль бачать мешканці приміщення, телефон — адміністратор.`, [
    [{ text: '✅ Надіслати заявку', callback_data: `reg:submit:${s.token}` }],
    [{ text: '✏️ Заповнити заново', callback_data: `reg:restart:${s.token}` }, ...cancel(s)],
  ]);
  const steps = sequence(f); const i = steps.indexOf(s.step);
  const min = f.entrance === 1 ? 2 : 1;
  const max = f.entrance === 1 ? 14 : f.entrance === 2 ? 9 : 10;
  const prompts: Record<string,string> = {
    kind: f.poll_id?'Щоб проголосувати, пройдіть коротку реєстрацію. Після неї ви зможете повернутися до голосування.\n\nЩо реєструємо?':'Що реєструємо?',
    number: 'Напишіть номер квартири.',
    business_name: 'Напишіть назву закладу.',
    floor: `Напишіть ваш поверх (${min}–${max}).`,
    name: 'Напишіть ім’я та прізвище.',
    phone: 'Напишіть номер телефону.',
    role: 'Оберіть вашу роль.',
  };
  const buttons: Button[][] = [];
  if (s.step === 'kind') buttons.push([{ text: '🏠 Квартира', callback_data: `reg:kind:${s.token}:apartment` }, { text: '🏪 Комерція', callback_data: `reg:kind:${s.token}:commercial` }]);
  if (s.step === 'role') buttons.push([{ text: '🔑 Власник', callback_data: `reg:role:${s.token}:owner` }, { text: '🏠 Орендар', callback_data: `reg:role:${s.token}:tenant` }, ...(f.kind==='apartment'?[{text:'Член сім’ї',callback_data:`reg:role:${s.token}:family`}]:[])]);
  buttons.push([...(i>0?[{text:'← Назад',callback_data:`reg:back:${s.token}`}]:[]),...cancel(s)]);
  return plainCard(env, s.user_id, prompts[s.step], buttons);
}
async function save(env: Env, s: Session, f: Form, step: string) {
  await env.HOME_DB.prepare('UPDATE sessions SET step=?,data=?,updated_at=unixepoch() WHERE user_id=? AND token=?').bind(step,JSON.stringify(f),s.user_id,s.token).run();
  return showForm(env, { ...s, step, data: JSON.stringify(f) });
}
export async function resumeRegistration(env:Env,uid:number,chatId:number) {
  const current=await env.HOME_DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(uid).first<Session>();
  if(current)return showForm(env,await normalizeSession(env,current));
  const pending=await env.HOME_DB.prepare("SELECT m.id FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.user_id=? AND p.chat_id=? AND m.status='pending' LIMIT 1").bind(uid,chatId).first();
  if(pending)return plainCard(env,uid,'Заявку надіслано. Очікуйте підтвердження.');
  return startRegistration(env,uid,`group_${Math.abs(chatId)}`);
}
export async function startRegistration(env: Env, uid: number, payload?: string, addAnother=false) {
  let chatId: number | null = null; let pollId: number | undefined;
  if (payload?.startsWith('poll_')) {
    pollId = positiveId(payload.slice(5)) || undefined;
    const poll = pollId ? await env.HOME_DB.prepare('SELECT chat_id FROM polls WHERE id=?').bind(pollId).first<{ chat_id:number }>() : null;
    chatId = poll?.chat_id || null;
  } else if (payload?.startsWith('group_')) chatId = groupId(`-${payload.slice(6)}`);
  else {
    const joining=await env.HOME_DB.prepare("SELECT j.chat_id FROM join_requests j JOIN groups g ON g.chat_id=j.chat_id WHERE j.user_id=? AND j.status='pending' AND j.decision='' AND g.status='approved' AND g.bot_present=1 ORDER BY j.update_id DESC LIMIT 1").bind(uid).first<{chat_id:number}>();
    const groups = await connectedGroups(env);
    if(joining)chatId=joining.chat_id;
    else if (groups.length === 1) chatId = groups[0].chat_id;
    else return plainCard(env, uid, '🏡 Оберіть будинок\nДля нового будинку відкрийте реєстрацію з голосування у його групі. Для вже доданого приміщення використайте «Мої приміщення».');
  }
  if (!chatId || !isConnected(await getGroup(env, chatId))) return plainCard(env, uid, 'Будинок недоступний\nГрупу ще не підключено або від’єднано.');
  if(!addAnother){
    const registered=await env.HOME_DB.prepare("SELECT m.id FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.user_id=? AND p.chat_id=? AND m.status='approved' LIMIT 1").bind(uid,chatId).first();
    if(registered){
      const message='✅ Ви вже зареєстровані!\n\nЩоб додати ще одну квартиру або комерцію, натисніть «➕ Додати приміщення» на клавіатурі внизу.';
      if(String(uid)===env.ADMIN_TELEGRAM_USER_ID){const {adminMenu}=await import('./poll-wizard.ts');await adminMenu(env,message);}
      else{const {residentMenu}=await import('./resident-menu.ts');await residentMenu(env,uid,message);}
      if(pollId)await returnToRegistrationPoll(env,uid,chatId,{poll_id:pollId});
      return;
    }
  }
  const s: Session = { user_id: uid, chat_id: chatId, token: token(), step: 'kind', data: JSON.stringify({ poll_id: pollId, ...await contactDefaults(env,uid) }) };
  await env.HOME_DB.prepare("INSERT INTO sessions(user_id,chat_id,token,step,data) VALUES (?,?,?,'kind',?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,token=excluded.token,step='kind',data=excluded.data,updated_at=unixepoch()")
    .bind(uid,chatId,s.token,s.data).run();
  return showForm(env,s);
}
export async function registrationMessage(env: Env, m: Message) {
  let s = await env.HOME_DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(m.from!.id).first<Session>();
  if (!s) {const {residentMenu}=await import('./resident-menu.ts');const {adminMenu}=await import('./poll-wizard.ts');return String(m.from!.id)===env.ADMIN_TELEGRAM_USER_ID?adminMenu(env):residentMenu(env,m.from!.id);}
  s = await normalizeSession(env,s);
  if (!isConnected(await getGroup(env,s.chat_id))) return showForm(env,s);
  const f = JSON.parse(s.data) as Form; const value = (m.text || '').trim();
  if (s.step === 'number') {
    if (f.kind === 'apartment') {
      const number = apartmentNumber(value); const entrance = number ? entranceForApartment(number) : null;
      if (!number || !entrance) return plainCard(env,s.user_id,'Введіть номер від 1 до 187. Можна з літерою А: 84А.');
      f.number = number; f.entrance = entrance;
    }
  } else if (s.step === 'floor') {
    const floor = validFloor(f.kind!,f.entrance!,value);
    if (floor === null) return plainCard(env,s.user_id,`Напишіть число від ${f.entrance===1?2:1} до ${f.entrance===1?14:f.entrance===2?9:10}.`);
    f.floor = floor;
  } else if (s.step === 'phone') {
    const phone = ukrainianPhone(value);
    if (!phone) return plainCard(env,s.user_id,'Перевірте номер. Наприклад: 067 123 45 67.');
    f.phone = phone;
  } else if (s.step === 'name' || s.step === 'business_name') {
    const text = value.replace(/\s+/g,' ');
    if (text.length < 2 || text.length > 100 || text.startsWith('/')) return plainCard(env,s.user_id,'Потрібен текст від 2 до 100 символів\nСпробуйте ще раз.');
    f[s.step] = text;
    if (s.step === 'business_name') f.number = commercialKey(text);
  } else return showForm(env,s);
  const steps = sequence(f);
  return save(env,s,f,steps[steps.indexOf(s.step)+1]);
}
const reviewButtons = (m: Membership): Button[][] => [[
  { text: '✅ Підтвердити', callback_data: `review:approve:${m.membership_id}:${m.application_token}` },
  { text: 'Відхилити', callback_data: `review:reject:${m.membership_id}:${m.application_token}` },
]];
async function notifyApplication(env: Env, m: Membership) {
  const group = await getGroup(env,m.chat_id); const f = JSON.parse(m.details) as Form;
  return plainCard(env,env.ADMIN_TELEGRAM_USER_ID,`📬 Заявка на приміщення\n🏘 ${group?.title}\n\n${description(f)}\n\nПідтвердьте особу, приміщення та право власності перед наданням ролі власника.`,reviewButtons(m));
}
export async function registrationCallback(env: Env,q: Callback): Promise<boolean> {
  if (!q.data?.startsWith('reg:') && !q.data?.startsWith('review:')) return false;
  if (q.message?.chat.type !== 'private' || q.message.chat.id !== q.from.id) { await registrationNotice(env,q,'Відкрийте особистий чат із ботом.'); return true; }
  const [namespace,action,value,extra] = q.data.split(':');
  if (namespace === 'review') {
    if (String(q.from.id) !== env.ADMIN_TELEGRAM_USER_ID) { await registrationNotice(env,q,'Лише для адміністратора.'); return true; }
    const id = positiveId(value);
    const m = id ? await env.HOME_DB.prepare(`${membershipSelect} WHERE m.id=? AND m.status='pending' AND m.application_token=?`).bind(id,extra || '').first<Membership>() : null;
    if (!m || !isConnected(await getGroup(env,m.chat_id))) { await registrationNotice(env,q,'Заявка застаріла або групу від’єднано.'); return true; }
    const f = JSON.parse(m.details) as Form;
    if (!['approve','reject'].includes(action)) { await registrationNotice(env,q,'Недоступна дія.'); return true; }
    if (action === 'approve') {
      if (!ukrainianPhone(m.phone)) { await registrationNotice(env,q,'Потрібен український номер телефону.'); return true; }
      const verified = await env.HOME_DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE premise_id=? AND status='approved'").bind(m.id).first<{n:number}>();
      if (m.kind === 'apartment' && verified?.n && ((m.floor !== null && f.floor !== m.floor) || (m.entrance !== null && f.entrance !== m.entrance))) {
        await registrationNotice(env,q,'Під’їзд або поверх не збігається з уже підтвердженим приміщенням. Відхиліть заявку та уточніть дані.'); return true;
      }

    }
    await env.HOME_DB.batch([
      env.HOME_DB.prepare("UPDATE memberships SET status=?,reviewed_by=?,reviewed_at=unixepoch(),version=version+1 WHERE id=? AND status='pending' AND application_token=?").bind(action === 'approve' ? 'approved' : 'rejected',q.from.id,m.membership_id,m.application_token),
      ...(action === 'approve' && f.floor !== undefined ? [env.HOME_DB.prepare('UPDATE premises SET entrance=?,floor=?,business_name=? WHERE id=?').bind(f.entrance!,f.floor,f.business_name || '',m.id)] : []),
      env.HOME_DB.prepare('INSERT INTO membership_audit(actor_id,membership_id,action) VALUES (?,?,?)').bind(q.from.id,m.membership_id,action),
    ]);
    await resolveJoin(env,m.user_id,m.chat_id,action==='approve');
    await answer(env,q.id,'');
    if (action === 'approve') await plainCard(env,q.from.id,`✅ Доступ надано\n${premiseLabel(m)} · ${m.name}`,[[{text:'👥 Користувачі приміщення',callback_data:`unit:members:${m.id}:0`}]]);
    const joined=action==='approve'?await env.HOME_DB.prepare("SELECT token FROM join_requests WHERE user_id=? AND chat_id=? AND status='approved'").bind(m.user_id,m.chat_id).first():null;
    if(!joined)await plainCard(env,m.user_id,action === 'approve' ? `🎉 Доступ підтверджено\n${premiseLabel(m)}\n\nВи можете голосувати від цього приміщення. Свої дані та список мешканців можна переглянути через клавіатуру внизу.` : `Заявку відхилено\n${premiseLabel(m)}\n\nУточніть дані з адміністратором і подайте заявку знову.`);
    if(!joined&&String(m.user_id)!==env.ADMIN_TELEGRAM_USER_ID){const {residentMenu}=await import('./resident-menu.ts');await residentMenu(env,m.user_id);}
    if(action==='approve')await returnToRegistrationPoll(env,m.user_id,m.chat_id,f);
    return true;
  }
  let s = await env.HOME_DB.prepare('SELECT * FROM sessions WHERE user_id=? AND token=?').bind(q.from.id,value || '').first<Session>();
  if (!s) { await registrationNotice(env,q,'Це стара кнопка. Відповідайте на останнє запитання внизу чату. Щоб почати заново, натисніть «Додати приміщення» на нижній клавіатурі.'); return true; }
  s = await normalizeSession(env,s);
  let f = JSON.parse(s.data) as Form;
  if (action === 'cancel') {
    await env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').bind(s.user_id,s.token).run();
    await registrationNotice(env,q,'Анкету скасовано.'); return true;
  }
  if (!isConnected(await getGroup(env,s.chat_id))) { await registrationNotice(env,q,'Групу від’єднано.'); return true; }
  if (action === 'restart') {
    const nextToken = token();
    const defaults = await contactDefaults(env,s.user_id);
    await env.HOME_DB.prepare("UPDATE sessions SET token=?,step='kind',data=?,updated_at=unixepoch() WHERE user_id=? AND token=?").bind(nextToken,JSON.stringify({poll_id:f.poll_id,...defaults}),s.user_id,s.token).run();
    await answer(env,q.id,''); await showForm(env,{...s,token:nextToken,step:'kind',data:JSON.stringify({poll_id:f.poll_id,...defaults})}); return true;
  }
  if (action === 'back') {
    const steps = sequence(f); const index = steps.indexOf(s.step);
    if (index > 0) { await answer(env,q.id,''); await save(env,s,f,steps[index-1]); }
    else await registrationNotice(env,q,'Це перший крок.'); return true;
  }
  if (action === 'kind' && s.step === 'kind' && ['apartment','commercial'].includes(extra)) {
    f = { kind: extra as Form['kind'], poll_id: f.poll_id, ...await contactDefaults(env,s.user_id) };
    await answer(env,q.id,''); await save(env,s,f,f.kind === 'commercial' ? 'business_name' : 'number'); return true;
  }
  if (action === 'role' && s.step === 'role' && (f.kind==='apartment'?['owner','tenant','family']:['owner','tenant']).includes(extra)) {
    f.role = extra as Form['role']; await answer(env,q.id,''); await save(env,s,f,'review'); return true;
  }
  const validProperty = f.kind === 'commercial' ? !!f.business_name && f.number === commercialKey(f.business_name)
    : !!f.number && !!f.entrance && f.floor !== undefined && entranceForApartment(f.number) === f.entrance && validFloor('apartment',f.entrance,String(f.floor)) !== null;
  if (action !== 'submit' || s.step !== 'review' || !f.kind || !validProperty || !f.name || !ukrainianPhone(f.phone || '') || !f.role) {
    await registrationNotice(env,q,'Натисніть кнопку під останнім запитанням внизу чату.'); return true;
  }
  let inGroup:boolean;
  try{
    const member=await telegram<{status:string;is_member?:boolean}>(env,'getChatMember',{chat_id:s.chat_id,user_id:s.user_id});
    inGroup=['member','administrator','creator'].includes(member.status)||(member.status==='restricted'&&member.is_member===true);
  }catch{
    await answer(env,q.id,'');await plainCard(env,s.user_id,'Не вдалося перевірити участь у групі. Натисніть «Надіслати заявку» ще раз.');return true;
  }
  let p = await env.HOME_DB.prepare('SELECT * FROM premises WHERE chat_id=? AND kind=? AND number=?').bind(s.chat_id,f.kind,f.number!).first<Premise>();
  if (!p && f.kind === 'commercial') {
    // Reuse numbered commerce created by the old form when the business name matches.
    const old = (await env.HOME_DB.prepare("SELECT * FROM premises WHERE chat_id=? AND kind='commercial'").bind(s.chat_id).all<Premise>()).results;
    p = old.find(item => commercialKey(item.business_name) === f.number) || null;
  }
  if (!p) {
    const number = f.kind === 'apartment' ? Number.parseInt(f.number!,10) : 0;
    await env.HOME_DB.prepare('INSERT INTO premises(chat_id,kind,number,business_name,entrance,floor,number_start,number_end) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,kind,number) DO NOTHING')
      .bind(s.chat_id,f.kind,f.number!,f.business_name || '',f.kind === 'apartment' ? f.entrance! : null,f.kind === 'apartment' ? f.floor! : null,number,number).run();
    p = await env.HOME_DB.prepare('SELECT * FROM premises WHERE chat_id=? AND kind=? AND number=?').bind(s.chat_id,f.kind,f.number!).first<Premise>();
  }
  if (!p) throw new Error('Premise creation failed');
  const existing = await env.HOME_DB.prepare('SELECT status FROM memberships WHERE user_id=? AND premise_id=?').bind(s.user_id,p.id).first<{status:string}>();
  if (existing && (existing.status==='approved'||(existing.status==='pending'&&!inGroup))) {
    await env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').bind(s.user_id,s.token).run();
    await registrationNotice(env,q,existing.status === 'approved' ? 'Це приміщення вже додано. Відкрийте «Мої приміщення».' : 'Заявка на це приміщення вже очікує перевірки.');
    if(existing.status==='approved')await returnToRegistrationPoll(env,s.user_id,s.chat_id,f);
    return true;
  }
  if(inGroup&&p.kind==='apartment'&&p.floor!==null&&p.floor!==f.floor){
    const verified=await env.HOME_DB.prepare("SELECT id FROM memberships WHERE premise_id=? AND status='approved' LIMIT 1").bind(p.id).first();
    if(verified){await answer(env,q.id,'');await plainCard(env,s.user_id,`Для цієї квартири вказано поверх ${p.floor}. Перевірте дані та заповніть заявку заново.`);return true;}
  }
  const status=inGroup?'approved':'pending';
  await env.HOME_DB.batch([
    env.HOME_DB.prepare('INSERT INTO profiles(user_id,name,phone) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,updated_at=unixepoch()').bind(s.user_id,f.name,ukrainianPhone(f.phone!)!),
    env.HOME_DB.prepare(`INSERT INTO memberships(user_id,premise_id,role,status,application_token,details) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id,premise_id) DO UPDATE SET role=excluded.role,status=excluded.status,application_token=excluded.application_token,details=excluded.details,version=memberships.version+1,reviewed_by=NULL,reviewed_at=NULL
      WHERE memberships.status IN ('rejected','revoked') OR (memberships.status='pending' AND excluded.status='approved')`).bind(s.user_id,p.id,f.role,status,s.token,JSON.stringify(f)),
    ...(inGroup&&f.floor!==undefined?[env.HOME_DB.prepare("UPDATE premises SET floor=?,entrance=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM memberships WHERE premise_id=? AND status='approved' AND user_id!=?)").bind(f.floor,f.entrance!,p.id,p.id,s.user_id)]:[]),
    ...(inGroup?[env.HOME_DB.prepare("INSERT INTO membership_audit(actor_id,membership_id,action) SELECT ?,id,'auto_approve_group_member' FROM memberships WHERE user_id=? AND premise_id=? AND application_token=?").bind(s.user_id,s.user_id,p.id,s.token)]:[]),
    env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').bind(s.user_id,s.token),
  ]);
  await answer(env,q.id,'');
  if(inGroup){
    const group=await getGroup(env,s.chat_id);
    await send(env,env.ADMIN_TELEGRAM_USER_ID,`✅ Зареєстровано: ${f.name}\n${premiseLabel(p)} · ${roleLabel(f.role!)}\n${group?.title||''}`);
    await plainCard(env,s.user_id,`✅ Реєстрацію завершено\n${premiseLabel(p)}`);
    if(String(s.user_id)!==env.ADMIN_TELEGRAM_USER_ID){const {residentMenu}=await import('./resident-menu.ts');await residentMenu(env,s.user_id);}
    await returnToRegistrationPoll(env,s.user_id,s.chat_id,f);
    return true;
  }
  await plainCard(env,s.user_id,`✅ Заявку надіслано\n${premiseLabel(p)}\n\nАдміністратор перевірить дані. Ми повідомимо тут про рішення. `);
  const membership = await env.HOME_DB.prepare(`${membershipSelect} WHERE m.user_id=? AND m.premise_id=?`).bind(s.user_id,p.id).first<Membership>();
  if (membership) await notifyApplication(env,membership);
  return true;
}
export async function pendingRegistrations(env: Env) {
  const { results } = await env.HOME_DB.prepare(`${membershipSelect} JOIN groups g ON g.chat_id=p.chat_id WHERE m.status='pending' AND g.status='approved' AND g.bot_present=1 ORDER BY m.created_at LIMIT 20`).all<Membership>();
  if (!results.length) return plainCard(env,env.ADMIN_TELEGRAM_USER_ID,'✅ Заявок немає\nУсі заявки вже розглянуто.');
  for (const m of results) await notifyApplication(env,m);
}
