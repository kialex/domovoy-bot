import type { Button, Callback, Env } from './env.ts';
import { answer, send, sendHtml, telegram } from './telegram.ts';
import { escapeHtml } from './presentation.ts';
import { getGroup, isConnected } from './groups.ts';
import { membershipSelect, ownMemberships, premiseLabel, roleLabel } from './premises.ts';
import type { Membership } from './premises.ts';
import { positiveId } from './validation.ts';
import { startRegistration } from './registration.ts';

export const RESIDENT_ACTIONS = {
  data: '👤 Мої дані', units: '🏠 Мої приміщення', polls: '🗳 Доступні голосування', add: '➕ Додати приміщення', menu: '🏠 Меню жителя',
};
const statusLabel: Record<string,string> = { approved: '✅ Підтверджено', pending: '⏳ На перевірці', revoked: '🚫 Доступ вимкнено', rejected: 'Відхилено' };
export async function residentMenu(env: Env, uid: number) {
  return telegram(env,'sendMessage',{
    chat_id:uid,text:'🏡 Кабінет мешканця\nОберіть дію на клавіатурі внизу. Ви можете додати кілька квартир або комерційних приміщень.',
    reply_markup:{keyboard:[[{text:RESIDENT_ACTIONS.data},{text:RESIDENT_ACTIONS.units}],[{text:RESIDENT_ACTIONS.polls}],[{text:RESIDENT_ACTIONS.add},{text:RESIDENT_ACTIONS.menu}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false},
  });
}
export async function showOwnData(env: Env, uid: number) {
  const profile = await env.HOME_DB.prepare('SELECT name,phone FROM profiles WHERE user_id=?').bind(uid).first<{name:string;phone:string}>();
  if (!profile) return send(env,uid,'👤 Даних ще немає\nНатисніть «Додати приміщення», щоб пройти реєстрацію.');
  const own = await ownMemberships(env,uid);
  return sendHtml(env,uid,`👤 <b>Мої дані</b>\n\nІм’я: ${escapeHtml(profile.name)}\nТелефон: ${escapeHtml(profile.phone)}\n\nПриміщень у підключених групах: <b>${own.length}</b>\nІм’я й телефон є спільними для ваших заявок. Роль і доступ перевіряються окремо для кожного приміщення.`,[[{text:RESIDENT_ACTIONS.units,callback_data:'resident:units:0'}]]);
}
export async function showOwnUnits(env: Env,uid:number,page=0) {
  const rows = await ownMemberships(env,uid);
  const buttons:Button[][]=rows.slice(page*8,page*8+8).map(m=>{
    const label=m.kind==='apartment'?`Кв. ${m.number} · поверх ${m.floor??'не вказано'}`:premiseLabel(m);
    return [{text:`${m.status==='approved'?'✅':'⏳'} ${label} · ${roleLabel(m.role)}`.slice(0,60),callback_data:`unit:view:${m.id}`}];
  });
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`resident:units:${page-1}`});
  if(rows.length>(page+1)*8)nav.push({text:'Далі →',callback_data:`resident:units:${page+1}`});
  if(nav.length)buttons.push(nav);
  buttons.push([{text:RESIDENT_ACTIONS.add,callback_data:'resident:add:0'}]);
  return send(env,uid,rows.length?'🏠 Мої приміщення\nОберіть квартиру або комерцію. Доступ і голоси враховуються окремо для кожного приміщення.':'🏠 Ви ще не додали приміщення.',buttons);
}
export async function addUnit(env:Env,uid:number,chatId?:number) {
  if(chatId)return startRegistration(env,uid,`group_${Math.abs(chatId)}`);
  const rows=await ownMemberships(env,uid);
  const ids=[...new Set(rows.map(m=>m.chat_id))];
  if(ids.length===1)return startRegistration(env,uid,`group_${Math.abs(ids[0])}`);
  if(ids.length>1){
    const buttons:Button[][]=[];
    for(const id of ids){const g=await getGroup(env,id);buttons.push([{text:(g?.title||String(id)).slice(0,60),callback_data:`resident:add:${id}`}]);}
    return send(env,uid,'У якому будинку додати приміщення?\nДля нового будинку відкрийте бота з голосування в його групі.',buttons);
  }
  return startRegistration(env,uid);
}
export function pollLink(chatId:number,messageId:number):string|null {
  const id=String(chatId);
  return id.startsWith('-100')?`https://t.me/c/${id.slice(4)}/${messageId}`:null;
}
export async function availablePolls(env:Env,uid:number,page=0) {
  const {results}=await env.HOME_DB.prepare(`SELECT DISTINCT p.id,p.question,p.chat_id,p.message_id,g.title FROM polls p JOIN groups g ON g.chat_id=p.chat_id
    JOIN premises u ON u.chat_id=p.chat_id JOIN memberships m ON m.premise_id=u.id
    WHERE m.user_id=? AND m.status='approved' AND p.status='open' AND (p.ends_at IS NULL OR p.ends_at>unixepoch()) AND g.status='approved' AND g.bot_present=1 ORDER BY p.id DESC LIMIT 9 OFFSET ?`).bind(uid,page*8).all<{id:number;question:string;chat_id:number;message_id:number;title:string}>();
  if(!results.length)return send(env,uid,'🗳 Відкритих голосувань поки немає\nТут з’являться голосування груп, де у вас є підтверджене приміщення.');
  for(const p of results.slice(0,8)){
    const link=pollLink(p.chat_id,p.message_id);
    await send(env,uid,`🗳 №${p.id} · ${p.title}\n${p.question}\n\n${link?'Відкрийте повідомлення у групі, щоб обрати відповідь.':'Відкрийте це голосування у групі будинку.'}`,link?[[{text:'Перейти до голосування',url:link}]]:undefined);
  }
  if(results.length>8)await send(env,uid,'Наступні голосування',[[{text:'Далі →',callback_data:`resident:polls:${page+1}`}]]);
}
async function showUnit(env:Env,uid:number,pid:number,showMembers=false,page=0) {
  const admin=String(uid)===env.ADMIN_TELEGRAM_USER_ID;
  const own=await env.HOME_DB.prepare(`${membershipSelect} WHERE m.user_id=? AND p.id=? AND m.status IN ('approved','pending')`).bind(uid,pid).first<Membership>();
  const any=own || (admin?await env.HOME_DB.prepare(`${membershipSelect} WHERE p.id=? LIMIT 1`).bind(pid).first<Membership>():null);
  if(!any || !isConnected(await getGroup(env,any.chat_id)))return send(env,uid,'Це приміщення недоступне.');
  if(showMembers && !admin && own?.status!=='approved')return send(env,uid,'Список мешканців стане доступним після підтвердження вашої заявки.');
  const group=await getGroup(env,any.chat_id);
  if(!showMembers)return sendHtml(env,uid,`<b>${escapeHtml(premiseLabel(any))}</b>\n🏘 ${escapeHtml(group?.title||'')}\n${any.kind==='apartment'?`Під’їзд: ${any.entrance??'уточнюється'} · Поверх: ${any.floor??'уточнюється'}`:''}\n\n${own?`${roleLabel(own.role)} · ${statusLabel[own.status]}`:'Перегляд адміністратора'}`,own?.status==='approved'||admin?[[{text:any.kind==='apartment'?'👥 Мешканці квартири':'👥 Користувачі приміщення',callback_data:`unit:members:${pid}:0`}]]:undefined);
  const rows=(await env.HOME_DB.prepare(`${membershipSelect} WHERE p.id=? AND m.status IN ('approved','pending') ORDER BY m.role,m.created_at LIMIT 9 OFFSET ?`).bind(pid,page*8).all<Membership>()).results;
  const canManage=admin||(own?.role==='owner'&&own.status==='approved');
  const lines=rows.slice(0,8).map(m=>`${m.role==='owner'?'🔑':'👤'} ${m.name} · ${roleLabel(m.role)} · ${statusLabel[m.status]}`);
  // Other members' phones never appear in this view.
  const buttons:Button[][]=[];
  if(canManage)for(const m of rows.slice(0,8)){if(m.user_id!==uid&&(m.role==='tenant'||admin))buttons.push([{text:`Вимкнути доступ: ${m.name}`.slice(0,60),callback_data:`unit:askremove:${m.membership_id}:${m.version}`}]);}
  const navigation:Button[]=[];
  if(page>0)navigation.push({text:'← Назад',callback_data:`unit:members:${pid}:${page-1}`});
  if(rows.length>8)navigation.push({text:'Далі →',callback_data:`unit:members:${pid}:${page+1}`});
  if(navigation.length)buttons.push(navigation);
  await sendHtml(env,uid,`👥 <b>${escapeHtml(premiseLabel(any))}</b>\n\n${escapeHtml(lines.join('\n'))}\n\n${canManage?'Власник може вимкнути доступ орендарю. Іншого власника може від’єднати тільки адміністратор.':'Керувати доступом може підтверджений власник.'}`,buttons);
}
export async function residentCallback(env:Env,q:Callback):Promise<boolean> {
  if(!q.data?.startsWith('resident:')&&!q.data?.startsWith('unit:'))return false;
  if(q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id){await answer(env,q.id,'Відкрийте особистий чат із ботом.');return true;}
  const [namespace,action,raw,rawVersion]=q.data.split(':');
  if(namespace==='resident'){
    await answer(env,q.id,'Відкриваю.');
    if(action==='data')await showOwnData(env,q.from.id);
    else if(action==='menu'){
      if(String(q.from.id)===env.ADMIN_TELEGRAM_USER_ID){const {adminMenu}=await import('./poll-wizard.ts');await adminMenu(env);}else await residentMenu(env,q.from.id);
    }
    else if(action==='add'){
      const id=Number(raw);if(Number.isSafeInteger(id)&&id<=0)await addUnit(env,q.from.id,id||undefined);
    }else{
      const page=Number(raw);if(!Number.isSafeInteger(page)||page<0||page>100000)return true;
      if(action==='units')await showOwnUnits(env,q.from.id,page);
      if(action==='polls')await availablePolls(env,q.from.id,page);
    }return true;
  }
  const id=positiveId(raw);
  if(!id){await answer(env,q.id,'Некоректний запис.');return true;}
  if(action==='view'||action==='members'){
    await answer(env,q.id,'Відкриваю приміщення.');const page=action==='members'?Number(rawVersion||0):0;
    if(Number.isSafeInteger(page)&&page>=0&&page<=100000)await showUnit(env,q.from.id,id,action==='members',page);return true;
  }
  const target=await env.HOME_DB.prepare(`${membershipSelect} WHERE m.id=? AND m.version=? AND m.status IN ('pending','approved')`).bind(id,Number(rawVersion)||0).first<Membership>();
  const admin=String(q.from.id)===env.ADMIN_TELEGRAM_USER_ID;
  const owner=target?await env.HOME_DB.prepare("SELECT id FROM memberships WHERE user_id=? AND premise_id=? AND role='owner' AND status='approved'").bind(q.from.id,target.id).first():null;
  if(!target||target.user_id===q.from.id||(!admin&&(!owner||target.role==='owner'))||!isConnected(await getGroup(env,target.chat_id))){await answer(env,q.id,'Немає права змінювати цей доступ або запис застарів.');return true;}
  if(action==='askremove'){
    await answer(env,q.id,'Підтвердіть дію.');
    await send(env,q.from.id,`Вимкнути доступ для ${target.name}?\n${premiseLabel(target)}\n\nДоступ до інших приміщень не зміниться. Уже поданий голос від цього приміщення залишиться без змін. Доступ до майбутніх голосувань буде вимкнено.`,[[{text:'Так, вимкнути доступ',callback_data:`unit:remove:${id}:${target.version}`}],[{text:'Залишити доступ',callback_data:`unit:members:${target.id}:0`}]]);return true;
  }
  if(action!=='remove'){await answer(env,q.id,'Недоступна дія.');return true;}
  await env.HOME_DB.batch([
    env.HOME_DB.prepare(`UPDATE memberships SET status='revoked',version=version+1,reviewed_by=?,reviewed_at=unixepoch() WHERE id=? AND version=? AND status IN ('pending','approved')
      AND (?=1 OR (role='tenant' AND EXISTS(SELECT 1 FROM memberships own WHERE own.user_id=? AND own.premise_id=memberships.premise_id AND own.role='owner' AND own.status='approved')))`).bind(q.from.id,id,target.version,Number(admin),q.from.id),

    env.HOME_DB.prepare("INSERT INTO membership_audit(actor_id,membership_id,action) SELECT ?,id,'revoke' FROM memberships WHERE id=? AND status='revoked' AND version=?").bind(q.from.id,id,target.version+1),
  ]);
  await answer(env,q.id,'Доступ вимкнено.');
  await send(env,env.ADMIN_TELEGRAM_USER_ID,`Змінено доступ до приміщення\n${premiseLabel(target)} · група ${target.chat_id}\nКористувач ${q.from.id} вимкнув доступ для ${target.name} (${target.user_id}).`);
  await send(env,target.user_id,`Доступ до ${premiseLabel(target).toLowerCase()} вимкнено.\nДоступ до інших приміщень зберігається. Якщо це помилка, зверніться до адміністратора.`);
  await showUnit(env,q.from.id,target.id,true);return true;
}
