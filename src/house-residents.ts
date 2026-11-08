import { residentTree, unitTree, unitState, treeData, parseTreeState } from './resident-tree.ts';
import type { Button, Callback, Env } from './env.ts';
import { answer, send, telegram } from './telegram.ts';
import { connectedGroups, getGroup, isConnected } from './groups.ts';
import { escapeHtml } from './presentation.ts';
import { membershipSelect, premiseLabel, roleLabel } from './premises.ts';
import type { Membership } from './premises.ts';
import { positiveId } from './validation.ts';

export const HOUSE_RESIDENTS='👥 Мешканці будинку';
export async function houseResidents(env:Env) {
  const groups=await connectedGroups(env);
  await telegram(env,'sendMessage',{chat_id:env.ADMIN_TELEGRAM_USER_ID,text:HOUSE_RESIDENTS,reply_markup:{keyboard:[[{text:HOUSE_RESIDENTS}],[{text:'🏠 Головне меню'}]],resize_keyboard:true,is_persistent:true,one_time_keyboard:false}});
  if(groups.length===1)return houseUnits(env,groups[0].chat_id);
  return houseChoices(env,0);
}
async function houseChoices(env:Env,page:number,messageId?:number) {
  const groups=await connectedGroups(env);
  const buttons:Button[][]=groups.slice(page*8,page*8+8).map(g=>[{text:g.title.slice(0,60),callback_data:`directory:house:${g.chat_id}:0`}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`directory:houses:${page-1}`});
  if(groups.length>(page+1)*8)nav.push({text:'Далі →',callback_data:`directory:houses:${page+1}`});
  if(nav.length)buttons.push(nav);
  return telegram(env,messageId?'editMessageText':'sendMessage',{chat_id:env.ADMIN_TELEGRAM_USER_ID,...(messageId?{message_id:messageId}:{}),text:groups.length?'Оберіть будинок.':'Підключених будинків немає.',reply_markup:{inline_keyboard:buttons}});
}
async function houseUnits(env:Env,chatId:number,messageId?:number) {
  return residentTree(env,{chat:chatId,entrance:'-',floor:'-',unit:0,page:0},messageId);
}
export async function directoryCallback(env:Env,q:Callback):Promise<boolean> {
  if(!q.data?.startsWith('directory:'))return false;
  await answer(env,q.id,'');
  if(String(q.from.id)!==env.ADMIN_TELEGRAM_USER_ID||q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id)return true;
  const [,action,raw,rawPage]=q.data.split(':');
  if(action==='tree'){const state=parseTreeState(q.data.split(':').slice(2));if(state)await residentTree(env,state,q.message.message_id);return true;}
  const page=Number(rawPage||0);
  if(!Number.isSafeInteger(page)||page<0||page>100000)return true;
  if(action==='houses'){
    const housePage=Number(raw);if(Number.isSafeInteger(housePage)&&housePage>=0&&housePage<=100000)await houseChoices(env,housePage,q.message.message_id);return true;
  }
  const id=Number(raw);if(!Number.isSafeInteger(id)||!id)return true;
  if(action==='house'){if(id<0)await houseUnits(env,id,q.message.message_id);return true;}
  if(!positiveId(raw))return true;
  if(action==='members'){await unitTree(env,id,page,q.message.message_id);return true;}
  if(action==='person'){
    const m=await env.HOME_DB.prepare(`${membershipSelect.replace('SELECT p.*','SELECT u.telegram_username,p.*')} WHERE m.id=? AND m.status IN ('approved','pending')`).bind(id).first<Membership>();
    if(!m||!isConnected(await getGroup(env,m.chat_id))){await send(env,q.from.id,'Мешканець недоступний.');return true;}
    const buttons:Button[][]=m.user_id===q.from.id?[]:[[{text:'Вимкнути доступ',callback_data:`unit:askremove:${m.membership_id}:${m.version}`}]];
    buttons.push([{text:'← До приміщення',callback_data:treeData(unitState(m))}]);
    await telegram(env,'editMessageText',{chat_id:q.from.id,message_id:q.message.message_id,parse_mode:'HTML',text:`<b>${escapeHtml(m.name)}</b>${m.telegram_username?` · @${escapeHtml(m.telegram_username)}`:''}\n${escapeHtml(premiseLabel(m))} · ${roleLabel(m.role)}\n📞 ${escapeHtml(m.phone)}${m.status==='pending'?'\n⏳ Заявка на перевірці':''}`,reply_markup:{inline_keyboard:buttons}});
  }
  return true;
}
