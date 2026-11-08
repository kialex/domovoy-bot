import {readFileSync,writeFileSync} from 'node:fs';
import {richPollPreview} from '../../src/poll-rich-preview.ts';
const result=JSON.parse(readFileSync('.wrangler/previews/generator-source-20261108.json','utf8'));
if(result.length!==3||result.some(r=>!r.success))throw new Error('Source query is incomplete');
const poll=result[0].results[0];
if(!poll||poll.id!==7||poll.chat_id!==-1003929118630)throw new Error('Source poll mismatch');
const options=JSON.parse(poll.options);
const counts=options.map((_,index)=>result[1].results.find(r=>r.option_index===index)?.count||0);
const units=result[2].results;
if(counts.reduce((a,b)=>a+b,0)!==units.length)throw new Error('Vote snapshot changed during query; fetch again');
const chatId=-1004489118093;
const sourceUrl=`https://t.me/c/${String(poll.chat_id).slice(4)}/${poll.message_id}`;
const time=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
const rich_message=richPollPreview({title:poll.question,description:poll.description,options,counts,daysRemaining:Math.max(0,Math.ceil((poll.ends_at-Date.now()/1000)/86400)),votedPremises:units.filter(r=>r.kind==='apartment').map(r=>r.number),votedCommerce:units.filter(r=>r.kind==='commercial').map(r=>r.business_name),previewUrl:sourceUrl,previewNote:`Копія для перегляду. Результати станом на ${time} (Київ). Кнопки відкривають початкове голосування.`});
async function api(method,body){
 const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!data.ok)throw new Error(`Telegram ${method} rejected: ${data.description||response.status}`);return data.result;
}
const chat=await api('getChat',{chat_id:chatId});if(chat.title!=='Тестовая группа')throw new Error('Target mismatch');
const message=await api('sendRichMessage',{chat_id:chatId,rich_message});
writeFileSync('.wrangler/previews/generator-copy-20261108.json',JSON.stringify({chat_id:chatId,message_id:message.message_id,source_poll_id:poll.id,source_url:sourceUrl,votes:units.length,sent_at:new Date().toISOString()}),{mode:0o600});
console.log(JSON.stringify({sent:true,message_id:message.message_id,votes:units.length,url:`https://t.me/c/4489118093/${message.message_id}`}));
