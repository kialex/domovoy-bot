import type { Button, Callback, Env } from './env.ts';
import { publicCollectionText, type Collection } from './collections.ts';
import { escapeHtml } from './presentation.ts';
import { answer, sendHtml, telegram } from './telegram.ts';
import { positiveId } from './validation.ts';

const PAGE_SIZE=8;
const access=`EXISTS (SELECT 1 FROM memberships m JOIN premises own ON own.id=m.premise_id
  WHERE m.user_id=? AND m.status='approved' AND own.chat_id=c.chat_id)`;
const visible="g.status='approved' AND g.bot_present=1 AND (c.message_id IS NOT NULL OR c.closed=1)";

export async function canViewCollections(env:Env,uid:number){
  return !!await env.HOME_DB.prepare(`SELECT m.id FROM memberships m JOIN premises p ON p.id=m.premise_id
    JOIN groups g ON g.chat_id=p.chat_id WHERE m.user_id=? AND m.status='approved'
    AND g.status='approved' AND g.bot_present=1 LIMIT 1`).bind(uid).first();
}
async function screen(env:Env,uid:number,text:string,buttons:Button[][],messageId?:number){
  if(messageId===undefined)return sendHtml(env,uid,text,buttons.length?buttons:undefined);
  const chat=await env.HOME_DB.prepare('SELECT chat_id FROM private_chats WHERE user_id=?').bind(uid).first<{chat_id:number}>();
  return telegram(env,'editMessageText',{chat_id:chat?.chat_id??uid,message_id:messageId,text,
    parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:buttons}});
}
export async function residentCollectionsMenu(env:Env,uid:number,page=0,messageId?:number){
  if(!await canViewCollections(env,uid))return screen(env,uid,'Збори доступні після підтвердження реєстрації.',[],messageId);
  const {results}=await env.HOME_DB.prepare(`SELECT c.id,c.title,c.closed FROM house_collections c
    JOIN groups g ON g.chat_id=c.chat_id WHERE ${visible} AND ${access}
    ORDER BY c.closed,c.id DESC LIMIT ? OFFSET ?`).bind(uid,PAGE_SIZE+1,page*PAGE_SIZE)
    .all<{id:number;title:string;closed:number}>();
  const buttons:Button[][]=results.slice(0,PAGE_SIZE).map(c=>[
    {text:((c.closed?'🏁 ':'')+c.title).slice(0,60),callback_data:`rc:view:${c.id}:0`},
  ]);
  if(page>0)buttons.push([{text:'← Назад',callback_data:`rc:list:${page-1}`}]);
  if(results.length>PAGE_SIZE)buttons.push([{text:'Далі →',callback_data:`rc:list:${page+1}`}]);
  return screen(env,uid,results.length?'Оберіть збір.':'Опублікованих зборів поки немає.',buttons,messageId);
}
async function residentCollection(env:Env,uid:number,id:number,page:number,messageId:number){
  // Recheck the house and membership on every page, including old or forwarded buttons.
  const collection=await env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE c.id=? AND ${visible} AND ${access}`).bind(id,uid).first<Collection>();
  if(!collection)return screen(env,uid,'Збір недоступний.',[],messageId);
  const {results}=await env.HOME_DB.prepare(`SELECT p.kind,p.number,p.business_name,t.amount FROM collection_totals t
    JOIN premises p ON p.id=t.premise_id AND p.chat_id=? WHERE t.collection_id=? AND t.amount>0
    ORDER BY p.kind,p.number_start,p.number LIMIT ? OFFSET ?`).bind(collection.chat_id,id,PAGE_SIZE+1,page*PAGE_SIZE)
    .all<{kind:string;number:string;business_name:string;amount:number}>();
  const rows=results.slice(0,PAGE_SIZE).map(p=>{
    const label=p.kind==='apartment'?`Кв. ${p.number}`:p.business_name;
    const amount=new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(p.amount/100);
    return `${escapeHtml(label)} — <b>${amount} грн</b>`;
  });
  const text=await publicCollectionText(env,collection);
  const contributions=rows.length?`\n\n<b>Зараховані внески:</b>\n${rows.join('\n')}`:'';
  const buttons:Button[][]=[];
  if(page>0)buttons.push([{text:'← Назад',callback_data:`rc:view:${id}:${page-1}`}]);
  if(results.length>PAGE_SIZE)buttons.push([{text:'Далі →',callback_data:`rc:view:${id}:${page+1}`}]);
  buttons.push([{text:'← До списку зборів',callback_data:'rc:list:0'}]);
  return screen(env,uid,text+contributions,buttons,messageId);
}
export async function residentCollectionCallback(env:Env,q:Callback){
  if(!q.data?.startsWith('rc:'))return false;
  await answer(env,q.id,'');
  if(q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id)return true;
  const [,action,raw,pageRaw,...extra]=q.data.split(':');
  if(extra.length)return true;
  if(action==='list'&&pageRaw===undefined&&/^\d{1,5}$/.test(raw||'')){
    await residentCollectionsMenu(env,q.from.id,Number(raw),q.message.message_id);
  }else if(action==='view'){
    const id=positiveId(raw);
    if(id&&/^\d{1,5}$/.test(pageRaw||''))await residentCollection(env,q.from.id,id,Number(pageRaw),q.message.message_id);
  }
  return true;
}
