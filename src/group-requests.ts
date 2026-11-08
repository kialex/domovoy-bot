import type { Button, Callback, Env, Message, User } from './env.ts';
import { getGroup, isConnected } from './groups.ts';
import { positiveId } from './validation.ts';
import { escapeHtml } from './presentation.ts';
import { answer, telegram } from './telegram.ts';

interface Identity extends User {username:string}
interface Poll {id:number;question:string}
interface RequestContext {chat_id:number;message_id:number;thread_id:number|null}
const identities=new WeakMap<Env,{bot:Identity;until:number}>();
async function botIdentity(env:Env){
  const old=identities.get(env);if(old&&old.until>Date.now())return old.bot;
  const bot=await telegram<Identity>(env,'getMe',{});
  if(!Number.isSafeInteger(bot.id)||!bot.username)throw new Error('Bot identity unavailable');
  identities.set(env,{bot,until:Date.now()+60000});return bot;
}
export function asksForVoters(text:string){
  const words=text.toLocaleLowerCase().replace(/@\w+/g,'').match(/[\p{L}]+/gu)||[];
  if(words.some((w,i)=>/^неголос/u.test(w)||(w==='не'&&words.slice(i+1,i+3).some(next=>/^(проголос|голосув|голосов)/u.test(next)))))return false;
  const voted=words.some(w=>/^(проголос|голосув|голосов)/u.test(w));
  const request=words.some(w=>/^(хто|кто|спис|перелік|покаж|покажіть|покажи|напиш|дай|дайте|які|какие|квартир|приміщен|помещен)/u.test(w));
  // "голосування" alone means a poll, not a request for its voters.
  const participants=words.some(w=>/^(хто|кто|спис|перелік|квартир|приміщен|помещен)/u.test(w));
  const past=words.some(w=>/^(проголос|голосував|голосували|голосовал|голосовав)/u.test(w));
  return voted&&request&&(participants||past);
}
async function reply(env:Env,c:Pick<RequestContext,'chat_id'|'message_id'|'thread_id'>,text:string,buttons?:Button[][]){
  return telegram(env,'sendMessage',{
    chat_id:c.chat_id,text,parse_mode:'HTML',
    reply_parameters:{message_id:c.message_id,allow_sending_without_reply:true},
    ...(c.thread_id?{message_thread_id:c.thread_id}:{}),
    ...(buttons?{reply_markup:{inline_keyboard:buttons}}:{}),
  });
}
async function publicVoters(env:Env,c:RequestContext,pollId:number){
  const rows=(await env.HOME_DB.prepare(`SELECT p.kind,p.number,p.business_name,p.entrance FROM premise_votes v JOIN premises p ON p.id=v.premise_id JOIN polls poll ON poll.id=v.poll_id WHERE v.poll_id=? AND poll.chat_id=? AND p.chat_id=poll.chat_id ORDER BY p.entrance,p.number_start,p.number,p.business_name`).bind(pollId,c.chat_id).all<{kind:string;number:string;business_name:string;entrance:number|null}>()).results;
  if(!rows.length)return reply(env,c,'Ще ніхто не проголосував.');
  const blocks:string[]=[];
  const entrances=[...new Set(rows.filter(r=>r.kind==='apartment').map(r=>r.entrance))];
  const groups=entrances.map(e=>({title:e===null?'Під’їзд не вказано':`Під’їзд ${e}`,units:rows.filter(r=>r.kind==='apartment'&&r.entrance===e).map(r=>r.number)}));
  const commerce=rows.filter(r=>r.kind==='commercial').map(r=>r.business_name||'Комерція');
  if(commerce.length)groups.push({title:'Комерція',units:commerce});
  for(const g of groups){
    const prefix=`<b>${escapeHtml(g.title)}:</b> `;let line=prefix;
    for(const unit of g.units){const label=escapeHtml(unit);if(line.length+label.length+2>3000){blocks.push(line);line=prefix;}line+=(line===prefix?'':', ')+label;}
    blocks.push(line);
  }
  let text='';for(const block of blocks){if(text.length+block.length+2>3800){await reply(env,c,text);text='';}text+=(text?'\n':'')+block;}
  return reply(env,c,text);
}
async function activePolls(env:Env,chat:number){return (await env.HOME_DB.prepare("SELECT id,question FROM polls WHERE chat_id=? AND status='open' AND (ends_at IS NULL OR ends_at>unixepoch()) ORDER BY created_at DESC,id DESC").bind(chat).all<Poll>()).results;}
async function choose(env:Env,c:RequestContext,page=0){
  const polls=await activePolls(env,c.chat_id);
  if(!polls.length)return reply(env,c,'У групі немає активних голосувань.');
  const buttons:Button[][]=polls.slice(page*8,page*8+8).map(p=>[{text:p.question.slice(0,60),callback_data:`gv:pick:${p.id}`}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`gv:page:${page-1}`});
  if(polls.length>(page+1)*8)nav.push({text:'Далі →',callback_data:`gv:page:${page+1}`});
  if(nav.length)buttons.push(nav);
  return reply(env,c,'За яким голосуванням показати список?',buttons);
}
export async function groupRequest(env:Env,m:Message){
  if(!m.from||m.from.is_bot||!['group','supergroup'].includes(m.chat.type)||!m.text)return;
  const mentions=(m.entities||[]).filter(e=>e.type==='mention');
  const direct=(m.entities||[]).filter(e=>e.type==='text_mention');
  if(!mentions.length&&!direct.length&&!m.reply_to_message?.from?.is_bot)return;
  const group=await getGroup(env,m.chat.id);if(!isConnected(group))return;
  const bot=await botIdentity(env);
  const tagged=mentions.some(e=>m.text!.slice(e.offset,e.offset+e.length).toLowerCase()===`@${bot.username.toLowerCase()}`)||direct.some(e=>e.user?.id===bot.id);
  const replied=m.reply_to_message?.from?.id===bot.id;
  if(!tagged&&!replied)return;
  const context:RequestContext={chat_id:m.chat.id,message_id:m.message_id,thread_id:m.message_thread_id||null};
  if(!asksForVoters(m.text))return reply(env,context,'Щоб побачити список, напишіть: «хто голосував».');
  if(replied){
    const mid=m.reply_to_message!.message_id;
    const poll=await env.HOME_DB.prepare(`SELECT p.id FROM polls p WHERE p.chat_id=? AND p.status IN ('open','closed') AND (p.message_id=? OR p.result_message_id=? OR EXISTS (SELECT 1 FROM poll_repost_runs r WHERE r.poll_id=p.id AND r.new_message_id=?) OR EXISTS (SELECT 1 FROM poll_message_cleanup c WHERE c.poll_id=p.id AND c.chat_id=p.chat_id AND c.message_id=?)) LIMIT 1`).bind(m.chat.id,mid,mid,mid,mid).first<{id:number}>();
    if(poll)return publicVoters(env,context,poll.id);
  }
  const polls=await activePolls(env,m.chat.id);
  if(!polls.length)return reply(env,context,'У групі немає активних голосувань.');
  if(polls.length===1)return publicVoters(env,context,polls[0].id);
  return choose(env,context);
}
export async function groupRequestCallback(env:Env,q:Callback){
  if(!q.data?.startsWith('gv:'))return false;
  await answer(env,q.id,'');
  if(!q.message||!['group','supergroup'].includes(q.message.chat.type))return true;
  const [,action,value,...extra]=q.data.split(':');
  if(extra.length||!['page','pick'].includes(action)||!/^\d+$/.test(value||''))return true;
  const c:RequestContext={chat_id:q.message.chat.id,message_id:q.message.message_id,thread_id:q.message.message_thread_id||null};
  if(!isConnected(await getGroup(env,c.chat_id)))return true;
  if(action==='page'){
    const page=Number(value);const polls=await activePolls(env,c.chat_id);
    if(Number.isSafeInteger(page)&&page>=0&&page*8<polls.length)await choose(env,c,page);
  }else if(action==='pick'){
    const pollId=positiveId(value);if(!pollId)return true;
    const poll=await env.HOME_DB.prepare("SELECT id FROM polls WHERE id=? AND chat_id=? AND status='open' AND (ends_at IS NULL OR ends_at>unixepoch())").bind(pollId,c.chat_id).first<{id:number}>();
    if(poll)await publicVoters(env,c,poll.id);
    else await reply(env,c,'Це голосування вже недоступне. Надішліть запит знову.');
  }
  return true;
}
