import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {richPollPreview} from '../../src/poll-rich-preview.ts';
const chatId=-1004489118093;
const base=`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/`;
async function api(method,body){
 const response=await fetch(base+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 if(!data.ok)throw new Error(`Telegram ${method} rejected: ${data.description||response.status}`);
 return data.result;
}
const chat=await api('getChat',{chat_id:chatId});
if(chat.title!=='Тестовая группа')throw new Error('The target group does not match');
const rich_message=richPollPreview({title:'Ремонт ліфта',description:'Пропонуємо замінити освітлення та кнопки в ліфті.\nВартість — 500 грн з квартири.',options:['Підтримую ремонт за запропонованою ціною','Потрібно розглянути дешевший варіант','Не підтримую ремонт'],counts:[12,6,2],daysRemaining:5,votedPremises:['12','15','25','74','84А'],votedCommerce:['Кав’ярня'],previewUrl:'https://t.me/c/4489118093/41'});
const previous=JSON.parse(readFileSync('.wrangler/previews/rich-text-20261108.json','utf8'));
if(previous.chat_id!==chatId)throw new Error('Preview target mismatch');
const message=process.argv.includes('--new')?await api('sendRichMessage',{chat_id:chatId,rich_message}):await api('editMessageText',{chat_id:chatId,message_id:previous.message_id,rich_message});
if(!message.rich_message)throw new Error('Telegram did not return a rich message');
const receipt={chat_id:chatId,message_id:message.message_id,kind:'rich-text-layout-preview',sent_at:new Date().toISOString()};
mkdirSync('.wrangler/previews',{recursive:true});writeFileSync('.wrangler/previews/rich-text-20261108.json',JSON.stringify(receipt),{mode:0o600});
console.log(JSON.stringify({sent:true,type:'rich_message',url:`https://t.me/c/${String(chatId).slice(4)}/${message.message_id}`,message_id:message.message_id}));
