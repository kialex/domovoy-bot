// Read-only capability probe, except for the explicitly requested test messages.
const base=`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/`;
const chatId=-1004489118093;
async function api(method,body){const r=await fetch(base+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const d=await r.json();return {ok:d.ok,status:r.status,result:d.result,error:d.description};}
const chat=await api('getChat',{chat_id:chatId});if(chat.result?.title!=='Тестовая группа')throw new Error('Wrong target group');
// Test eligibility using a documented custom emoji. A rejected request sends nothing.
const text='🧪 Перевірка спеціальних емодзі: 🟦';
const probe=await api('sendMessage',{chat_id:chatId,text,entities:[{type:'custom_emoji',offset:text.lastIndexOf('🟦'),length:2,custom_emoji_id:'5368324170671202286'}],disable_notification:true});
console.log(JSON.stringify({ok:probe.ok,status:probe.status,error:probe.error,custom_entities:probe.result?.entities?.filter(e=>e.type==='custom_emoji').length,message_id:probe.result?.message_id}));
if(probe.ok){const deleted=await api('deleteMessage',{chat_id:chatId,message_id:probe.result.message_id});console.log(JSON.stringify({probe_removed:deleted.ok}));}
