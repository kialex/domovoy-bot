import { residentKeyboard } from './resident-menu.ts';
import type { Callback, ChatJoinRequest, Env } from './env.ts';
import { answer, send, telegram } from './telegram.ts';
import { getGroup, isConnected } from './groups.ts';
import { startRegistration } from './registration.ts';

async function registered(env:Env,uid:number,chat:number) {
 return !!await env.HOME_DB.prepare(`SELECT m.id FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.user_id=? AND p.chat_id=? AND m.status='approved' LIMIT 1`).bind(uid,chat).first();
}
export async function welcomeJoined(env:Env,uid:number,chat:number) {
 const group=await getGroup(env,chat);
 if(!isConnected(group)||!await registered(env,uid,chat))return;
 const claim=await env.HOME_DB.prepare(`UPDATE join_requests SET welcome_lease_until=unixepoch()+180,welcome_attempts=welcome_attempts+1 WHERE user_id=? AND chat_id=? AND status='approved' AND welcomed=0 AND welcome_attempts<3 AND (welcome_lease_until IS NULL OR welcome_lease_until<unixepoch())`).bind(uid,chat).run();
 if(!claim.meta.changes)return;
 const row=await env.HOME_DB.prepare('SELECT token FROM join_requests WHERE user_id=? AND chat_id=?').bind(uid,chat).first<{token:string}>();
 if(!row)return;
 try{
  await telegram(env,'sendMessage',{chat_id:uid,text:`🏡 Вітаємо у «${group.title}»!\n\nТут можна голосувати, переглядати свої дані та мешканців квартири, додавати інші приміщення.\n\nКнопки — внизу чату.`,...(String(uid)===env.ADMIN_TELEGRAM_USER_ID?{}:{reply_markup:residentKeyboard()})});
  await env.HOME_DB.prepare('UPDATE join_requests SET welcomed=1 WHERE token=?').bind(row.token).run();
 }catch{console.error('Join welcome deferred');}
 finally{await env.HOME_DB.prepare('UPDATE join_requests SET welcome_lease_until=NULL WHERE token=?').bind(row.token).run();}
}
export async function processJoin(env:Env,uid:number,chat:number) {
 const row=await env.HOME_DB.prepare("SELECT * FROM join_requests WHERE user_id=? AND chat_id=? AND status='pending' AND decision!=''").bind(uid,chat).first<{token:string;decision:string;attempts:number}>();
 if(!row||!isConnected(await getGroup(env,chat)))return;
 if(row.decision==='approve'&&!await registered(env,uid,chat))return;
 try{
  await telegram(env,row.decision==='approve'?'approveChatJoinRequest':'declineChatJoinRequest',{chat_id:chat,user_id:uid});
 }catch{
  // A timeout may follow a successful approval. Check membership before retrying.
  if(row.decision==='approve'){
   try{const member=await telegram<{status:string;is_member?:boolean}>(env,'getChatMember',{chat_id:chat,user_id:uid});
    if(['member','administrator','creator'].includes(member.status)||(member.status==='restricted'&&member.is_member)){
     await env.HOME_DB.prepare("UPDATE join_requests SET status='approved' WHERE token=? AND status='pending'").bind(row.token).run();await welcomeJoined(env,uid,chat);return;
    }
   }catch{/* Keep the request pending. */}
  }
  await env.HOME_DB.prepare('UPDATE join_requests SET attempts=attempts+1 WHERE token=?').bind(row.token).run();
  if(!row.attempts){const g=await getGroup(env,chat);await send(env,env.ADMIN_TELEGRAM_USER_ID,`Не вдалося ${row.decision==='approve'?'прийняти':'відхилити'} заявку до «${g?.title}». Перевірте право бота запрошувати учасників.`,[[{text:'Повторити',callback_data:`join:retry:${row.token}`}]]);}
  return;
 }
 await env.HOME_DB.prepare('UPDATE join_requests SET status=? WHERE token=? AND status=\'pending\'').bind(row.decision==='approve'?'approved':'rejected',row.token).run();
 if(row.decision==='approve')await welcomeJoined(env,uid,chat);
}
export async function resolveJoin(env:Env,uid:number,chat:number,approved:boolean) {
 const decision=approved||await registered(env,uid,chat)?'approve':'decline';
 await env.HOME_DB.prepare("UPDATE join_requests SET decision=? WHERE user_id=? AND chat_id=? AND status='pending'").bind(decision,uid,chat).run();
 await processJoin(env,uid,chat);
}
export async function joinRequest(env:Env,r:ChatJoinRequest,updateId:number) {
 if(r.from.is_bot||!Number.isSafeInteger(r.from.id)||!Number.isSafeInteger(r.user_chat_id)||!isConnected(await getGroup(env,r.chat.id)))return;
 const key=crypto.randomUUID().replace(/-/g,'').slice(0,16);
 await env.HOME_DB.prepare(`INSERT INTO join_requests(chat_id,user_id,token,request_date,update_id,welcomed) VALUES (?,?,?,?,?,0) ON CONFLICT(chat_id,user_id) DO UPDATE SET token=excluded.token,request_date=excluded.request_date,update_id=excluded.update_id,status='pending',decision='',attempts=0,notified=0,welcomed=0,welcome_attempts=0,welcome_lease_until=NULL WHERE excluded.update_id>join_requests.update_id`).bind(r.chat.id,r.from.id,key,r.date,updateId).run();
 const row=await env.HOME_DB.prepare('SELECT * FROM join_requests WHERE chat_id=? AND user_id=?').bind(r.chat.id,r.from.id).first<{token:string;update_id:number;notified:number;status:string}>();
 if(!row||row.update_id!==updateId||row.status!=='pending')return;
 await env.HOME_DB.prepare('INSERT INTO private_chats(user_id,chat_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id').bind(r.from.id,r.user_chat_id).run();
 if(await registered(env,r.from.id,r.chat.id)){await resolveJoin(env,r.from.id,r.chat.id,true);return;}
 if(row.notified)return;
 try{
  const group=await getGroup(env,r.chat.id);
  await send(env,r.from.id,`🏡 Вітаємо! Це HomeBot — помічник мешканців будинку.\n\nЩоб вступити до групи «${group?.title}», пройдіть коротку реєстрацію. Після цього дочекайтеся, поки адміністратор перевірить дані та прийме вашу заявку.\n\nЧерез бот можна голосувати, переглядати свої дані та мешканців квартири.`,[[{text:'Почати реєстрацію',callback_data:`join:start:${row.token}`}]]);
  await env.HOME_DB.prepare('UPDATE join_requests SET notified=1 WHERE token=?').bind(row.token).run();
 }catch{
  await send(env,env.ADMIN_TELEGRAM_USER_ID,'Не вдалося надіслати реєстрацію новому учаснику. Попросіть його відкрити бота та натиснути «Почати».');
 }
}
export async function joinCallback(env:Env,q:Callback):Promise<boolean> {
 if(!q.data?.startsWith('join:'))return false;
 await answer(env,q.id,'');
 const [,action,token]=q.data.split(':');
 if(q.message?.chat.type!=='private')return true;
 const row=await env.HOME_DB.prepare("SELECT * FROM join_requests WHERE token=? AND status='pending'").bind(token||'').first<{user_id:number;chat_id:number;decision:string}>();
 if(!row)return true;
 if(action==='retry'&&String(q.from.id)===env.ADMIN_TELEGRAM_USER_ID){await processJoin(env,row.user_id,row.chat_id);return true;}
 if(action!=='start'||q.from.id!==row.user_id||!isConnected(await getGroup(env,row.chat_id)))return true;
 if(row.decision){await send(env,q.from.id,'Заявку вже розглянуто. Очікуйте рішення щодо вступу.');return true;}
 const pending=await env.HOME_DB.prepare(`SELECT m.id FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.user_id=? AND p.chat_id=? AND m.status='pending' LIMIT 1`).bind(row.user_id,row.chat_id).first();
 if(pending){await send(env,q.from.id,'Заявку надіслано. Очікуйте підтвердження.');return true;}
 const s=await env.HOME_DB.prepare('SELECT chat_id FROM sessions WHERE user_id=?').bind(row.user_id).first<{chat_id:number}>();
 if(s){await send(env,q.from.id,'Продовжіть заповнення анкети в цьому чаті.');return true;}
 await startRegistration(env,row.user_id,`group_${Math.abs(row.chat_id)}`);return true;
}
export async function retryJoins(env:Env) {
 const {results}=await env.HOME_DB.prepare("SELECT user_id,chat_id FROM join_requests WHERE status='pending' AND decision!='' ORDER BY attempts,update_id LIMIT 3").all<{user_id:number;chat_id:number}>();
 for(const row of results){try{await processJoin(env,row.user_id,row.chat_id);}catch{console.error('Join request deferred');}}
 const welcomes=await env.HOME_DB.prepare("SELECT user_id,chat_id FROM join_requests WHERE status='approved' AND welcomed=0 AND welcome_attempts<3 ORDER BY update_id LIMIT 3").all<{user_id:number;chat_id:number}>();
 for(const row of welcomes.results){try{await welcomeJoined(env,row.user_id,row.chat_id);}catch{console.error('Join welcome deferred');}}
}
