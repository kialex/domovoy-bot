import type { Button, Callback, Env } from './env.ts';
import { answer, send, sendHtml, telegram } from './telegram.ts';
import { connectedGroups, getGroup, isConnected } from './groups.ts';
import { escapeHtml } from './presentation.ts';
import { membershipSelect, premiseLabel, roleLabel } from './premises.ts';
import type { Membership, Premise } from './premises.ts';
import { positiveId } from './validation.ts';

export const HOUSE_RESIDENTS='👥 Мешканці будинку';
export async function houseResidents(env:Env) {
  const groups=await connectedGroups(env);
  await telegram(env,'sendMessage',{chat_id:env.ADMIN_TELEGRAM_USER_ID,text:HOUSE_RESIDENTS,reply_markup:{keyboard:[[{text:HOUSE_RESIDENTS}],[{text:'🏠 Головне меню'}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false}});
  if(groups.length===1)return houseUnits(env,groups[0].chat_id);
  return houseChoices(env,0);
}
async function houseChoices(env:Env,page:number) {
  const groups=await connectedGroups(env);
  const buttons:Button[][]=groups.slice(page*8,page*8+8).map(g=>[{text:g.title.slice(0,60),callback_data:`directory:house:${g.chat_id}:0`}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`directory:houses:${page-1}`});
  if(groups.length>(page+1)*8)nav.push({text:'Далі →',callback_data:`directory:houses:${page+1}`});
  if(nav.length)buttons.push(nav);
  return send(env,env.ADMIN_TELEGRAM_USER_ID,groups.length?'Оберіть будинок.':'Підключених будинків немає.',buttons);
}
async function houseUnits(env:Env,chatId:number,page=0) {
  const group=await getGroup(env,chatId);
  if(!isConnected(group))return send(env,env.ADMIN_TELEGRAM_USER_ID,'Будинок недоступний.');
  const {results}=await env.HOME_DB.prepare(`SELECT p.* FROM premises p WHERE p.chat_id=? AND EXISTS (SELECT 1 FROM memberships m WHERE m.premise_id=p.id AND m.status IN ('approved','pending')) ORDER BY p.kind,p.entrance,p.number_start,p.number,p.business_name LIMIT 9 OFFSET ?`).bind(chatId,page*8).all<Premise>();
  const buttons:Button[][]=results.slice(0,8).map(p=>[{text:(p.kind==='apartment'?`Кв. ${p.number} · під’їзд ${p.entrance??'—'}`:premiseLabel(p)).slice(0,60),callback_data:`directory:members:${p.id}:0`}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`directory:house:${chatId}:${page-1}`});
  if(results.length>8)nav.push({text:'Далі →',callback_data:`directory:house:${chatId}:${page+1}`});
  if(nav.length)buttons.push(nav);
  return send(env,env.ADMIN_TELEGRAM_USER_ID,`${group.title}\n\n${results.length?'Оберіть квартиру або заклад.':'Мешканців ще немає.'}`,buttons);
}
async function unitPeople(env:Env,id:number,page:number) {
  const p=await env.HOME_DB.prepare('SELECT * FROM premises WHERE id=?').bind(id).first<Premise>();
  if(!p||!isConnected(await getGroup(env,p.chat_id)))return send(env,env.ADMIN_TELEGRAM_USER_ID,'Приміщення недоступне.');
  const {results}=await env.HOME_DB.prepare(`${membershipSelect} WHERE p.id=? AND m.status IN ('approved','pending') ORDER BY u.name,m.id LIMIT 9 OFFSET ?`).bind(id,page*8).all<Membership>();
  const buttons:Button[][]=results.slice(0,8).map(m=>[{text:`${m.name} · ${roleLabel(m.role)}${m.status==='pending'?' · Заявка':''}`.slice(0,60),callback_data:`directory:person:${m.membership_id}`}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`directory:members:${id}:${page-1}`});
  if(results.length>8)nav.push({text:'Далі →',callback_data:`directory:members:${id}:${page+1}`});
  if(nav.length)buttons.push(nav);
  return send(env,env.ADMIN_TELEGRAM_USER_ID,`${premiseLabel(p)}\n\n${results.length?'Оберіть мешканця.':'Мешканців немає.'}`,buttons);
}
export async function directoryCallback(env:Env,q:Callback):Promise<boolean> {
  if(!q.data?.startsWith('directory:'))return false;
  await answer(env,q.id,'');
  if(String(q.from.id)!==env.ADMIN_TELEGRAM_USER_ID||q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id)return true;
  const [,action,raw,rawPage]=q.data.split(':');
  const page=Number(rawPage||0);
  if(!Number.isSafeInteger(page)||page<0||page>100000)return true;
  if(action==='houses'){
    const housePage=Number(raw);if(Number.isSafeInteger(housePage)&&housePage>=0&&housePage<=100000)await houseChoices(env,housePage);return true;
  }
  const id=Number(raw);if(!Number.isSafeInteger(id)||!id)return true;
  if(action==='house'){if(id<0)await houseUnits(env,id,page);return true;}
  if(!positiveId(raw))return true;
  if(action==='members'){await unitPeople(env,id,page);return true;}
  if(action==='person'){
    const m=await env.HOME_DB.prepare(`${membershipSelect} WHERE m.id=? AND m.status IN ('approved','pending')`).bind(id).first<Membership>();
    if(!m||!isConnected(await getGroup(env,m.chat_id))){await send(env,q.from.id,'Мешканець недоступний.');return true;}
    const buttons:Button[][]=m.user_id===q.from.id?[]:[[{text:'Вимкнути доступ',callback_data:`unit:askremove:${m.membership_id}:${m.version}`}]];
    await sendHtml(env,q.from.id,`<b>${escapeHtml(m.name)}</b>\n${escapeHtml(premiseLabel(m))} · ${roleLabel(m.role)}\n📞 ${escapeHtml(m.phone)}${m.status==='pending'?'\n⏳ Заявка на перевірці':''}`,buttons);
  }
  return true;
}
