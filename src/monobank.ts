import type { Button, Callback, Env, Message } from './env.ts';
import { recordBankContribution } from './collections.ts';
import { connectedGroups, getGroup, isConnected } from './groups.ts';
import { escapeHtml } from './presentation.ts';
import { answer, send, sendHtml, telegram } from './telegram.ts';

export const FUNDS='🫙 Банки monobank';
const now=()=>Math.floor(Date.now()/1000);
const id=()=>crypto.randomUUID().replace(/-/g,'').slice(0,12);
const money=(n:number)=>new Intl.NumberFormat('uk-UA',{maximumFractionDigits:2}).format(n/100)+' ₴';
interface Jar {id:string;title:string;balance:number;goal?:number;currencyCode:number;sendId?:string}
interface Setup {nonce:string;step:string;connection_id:string|null;jar_id:string|null;chat_id:number|null;deposits:number;daily:number;goal_notice:number;expires_at:number}
interface Connection {id:string;token_cipher:string;jars:string;last_request_at:number}
interface Fund {id:string;connection_id:string;jar_id:string;chat_id:number;group_version:number;title:string;balance:number;goal:number;active:number;deposits:number;daily:number;goal_notice:number;started_at:number;checked_at:number;goal_sent:number;error:string}
interface Operation {id:string;time:number;amount:number;balance:number;hold:boolean;comment?:string}
async function key(env:Env){
  if(!env.MONOBANK_ENCRYPTION_KEY)throw new Error('Monobank key missing');
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.MONOBANK_ENCRYPTION_KEY)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function encryptMonoToken(env:Env,token:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),new TextEncoder().encode(token)));
  return btoa(String.fromCharCode(...iv,...cipher));
}
async function decrypt(env:Env,cipher:string){
  const bytes=Uint8Array.from(atob(cipher),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await key(env),bytes.slice(12)));
}
async function api<T>(token:string,path:string):Promise<T>{
  let r:Response;
  try{r=await fetch('https://api.monobank.ua/personal/'+path,{headers:{'X-Token':token},signal:AbortSignal.timeout(10000)});}catch{throw new Error('Mono unavailable');}
  if(!r.ok)throw new Error(r.status===401||r.status===403?'Mono access denied':r.status===429?'Mono rate limit':'Mono unavailable');
  return r.json() as Promise<T>;
}
const admin=(env:Env,uid:number)=>String(uid)===env.ADMIN_TELEGRAM_USER_ID;
const settingsButtons=(s:Setup):Button[][]=>[
  [{text:`${s.deposits?'✅':'▫️'} Кожне поповнення`,callback_data:`mono:deposits:${s.nonce}`}],
  [{text:`${s.daily?'✅':'▫️'} Щоденний підсумок о 20:00`,callback_data:`mono:daily:${s.nonce}`}],
  [{text:`${s.goal_notice?'✅':'▫️'} Досягнення цілі`,callback_data:`mono:goal_notice:${s.nonce}`}],
  [{text:'Переглянути повідомлення',callback_data:`mono:preview:${s.nonce}`}],
];
export async function clearMonoSetup(env:Env){
  await env.HOME_DB.prepare('DELETE FROM mono_setup WHERE user_id=?').bind(env.ADMIN_TELEGRAM_USER_ID).run();
  await env.HOME_DB.prepare('DELETE FROM mono_connections WHERE id NOT IN (SELECT connection_id FROM mono_funds) AND id NOT IN (SELECT connection_id FROM mono_setup WHERE connection_id IS NOT NULL)').run();
}
export async function fundsMenu(env:Env){
  await clearMonoSetup(env);
  const rows=(await env.HOME_DB.prepare('SELECT * FROM mono_funds ORDER BY started_at DESC').all<Fund>()).results;
  return telegram(env,'sendMessage',{chat_id:env.ADMIN_TELEGRAM_USER_ID,text:rows.length?'Ваші збори. Оберіть потрібний.':'Щоб підключити банку, натисніть «➕ Додати збір» унизу. Потім надішліть свій токен monobank — бот покаже ваші банки для вибору.',reply_markup:{keyboard:[[{text:'➕ Додати збір'}],[{text:'🏠 Головне меню'}]],resize_keyboard:true,is_persistent:true}}).then(async()=>{
    for(const f of rows)await fundCard(env,f);
  });
}
async function fundCard(env:Env,f:Fund){
  return send(env,env.ADMIN_TELEGRAM_USER_ID,`${f.title}\n${money(f.balance)}${f.goal?` із ${money(f.goal)}`:''}\n${f.active?'Відстеження увімкнено':'Відстеження призупинено'}${f.error?'\nНе вдалося оновити дані. Перевірте доступ monobank.':''}`,[
    [{text:f.active?'Призупинити':'Відновити',callback_data:`mono:pause:${f.id}`}],
    [{text:'Налаштувати повідомлення',callback_data:`mono:edit:${f.id}`}],
    [{text:'Відключити банку',callback_data:`mono:remove:${f.id}`}],
  ]);
}
export async function startMono(env:Env){
  if(!env.MONOBANK_ENCRYPTION_KEY)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Підключення monobank ще не налаштоване.');
  if(!(await connectedGroups(env)).length)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Спочатку підключіть групу.');
  const other=await env.HOME_DB.prepare('SELECT user_id FROM sessions WHERE user_id=? UNION SELECT user_id FROM poll_drafts WHERE user_id=? AND step<>\'published\'').bind(env.ADMIN_TELEGRAM_USER_ID,env.ADMIN_TELEGRAM_USER_ID).first();
  if(other)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Спочатку завершіть або скасуйте поточне заповнення.');
  await clearMonoSetup(env);
  await env.HOME_DB.prepare("INSERT INTO mono_setup(user_id,nonce,step,expires_at) VALUES (?,?,'token',unixepoch()+900)").bind(env.ADMIN_TELEGRAM_USER_ID,id()).run();
  return telegram(env,'sendMessage',{chat_id:env.ADMIN_TELEGRAM_USER_ID,text:'Надішліть свій токен monobank у цей чат.\n\nОтримати токен: api.monobank.ua → увійдіть через застосунок monobank → скопіюйте токен.\n\nПісля цього оберете банку зі списку. Повідомлення з токеном бот видалить.',reply_markup:{keyboard:[[{text:'✕ Скасувати заповнення'}]],resize_keyboard:true,is_persistent:true}});
}
export async function monoMessage(env:Env,m:Message){
  if(!m.from||!admin(env,m.from.id))return false;
  const s=await env.HOME_DB.prepare("SELECT * FROM mono_setup WHERE user_id=? AND step='token'").bind(m.from.id).first<Setup>();
  if(!s)return false;
  try{await telegram(env,'deleteMessage',{chat_id:m.chat.id,message_id:m.message_id});}catch{
    await send(env,m.from.id,'Не вдалося видалити повідомлення. Видаліть його самостійно й повторіть підключення.');return true;
  }
  if(s.expires_at<=now()){await clearMonoSetup(env);await send(env,m.from.id,'Час підключення минув. Натисніть «Додати збір» знову.');return true;}
  const token=m.text?.trim()||'';
  if(!/^[A-Za-z0-9_-]{20,512}$/.test(token)){await send(env,m.from.id,'Надішліть токен, скопійований із api.monobank.ua.');return true;}
  let jars:Jar[];
  try{
    const data=await api<{jars:Jar[]}>(token,'client-info');
    if(!Array.isArray(data.jars))throw new Error('Invalid jars');
    jars=data.jars.filter(j=>j.currencyCode===980&&typeof j.id==='string'&&typeof j.title==='string'&&Number.isSafeInteger(j.balance)&&(j.goal===undefined||Number.isSafeInteger(j.goal)));
    jars=jars.map(j=>({id:j.id,title:j.title.slice(0,150),balance:j.balance,goal:j.goal,currencyCode:j.currencyCode,sendId:j.sendId}));
  }catch{await send(env,m.from.id,'Не вдалося підключитися. Перевірте токен або спробуйте через хвилину.');return true;}
  if(!jars.length){await send(env,m.from.id,'Не знайдено гривневих банок. Створіть банку в monobank і спробуйте ще раз.');return true;}
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  const existing=await env.HOME_DB.prepare('SELECT id FROM mono_connections WHERE token_fingerprint=?').bind(fingerprint).first<{id:string}>();
  const connection=existing?.id||id();
  await env.HOME_DB.batch([
    env.HOME_DB.prepare('INSERT INTO mono_connections(id,token_fingerprint,token_cipher,jars) VALUES (?,?,?,?) ON CONFLICT(token_fingerprint) DO UPDATE SET jars=excluded.jars').bind(connection,fingerprint,await encryptMonoToken(env,token),JSON.stringify(jars)),
    env.HOME_DB.prepare("UPDATE mono_setup SET step='jar',connection_id=? WHERE user_id=? AND nonce=?").bind(connection,m.from.id,s.nonce),
  ]);
  await send(env,m.from.id,'Яку банку відстежувати?',jars.map((j,i)=>[{text:`${j.title} · ${money(j.balance)}`.slice(0,64),callback_data:`mono:jar:${s.nonce}:${i}`} ]));return true;
}
async function setupFor(env:Env,nonce:string){return env.HOME_DB.prepare('SELECT * FROM mono_setup WHERE user_id=? AND nonce=? AND expires_at>unixepoch()').bind(env.ADMIN_TELEGRAM_USER_ID,nonce).first<Setup>();}
async function chosenJar(env:Env,s:Setup){
  const c=await env.HOME_DB.prepare('SELECT * FROM mono_connections WHERE id=?').bind(s.connection_id).first<Connection>();
  return c?(JSON.parse(c.jars) as Jar[]).find(j=>j.id===s.jar_id):undefined;
}
function balanceLine(title:string,balance:number,goal:number,comment?:string){return `${escapeHtml(title)}${comment?`\n💬 ${escapeHtml(comment)}`:''}\nЗібрано <b>${money(balance)}</b>${goal?` із ${money(goal)}`:''}`;}
function depositText(title:string,amount:number,balance:number,goal:number,comment?:unknown){const note=typeof comment==='string'?comment.replace(/\s+/g,' ').trim().slice(0,300):'';return `💸 <b>+${money(amount)} у банку</b>\n${balanceLine(title,balance,goal,note)}\nДякуємо за внесок!`;}
function dailyText(title:string,total:number,balance:number,goal:number){return `💰 <b>Підсумки збору за день</b>\n${escapeHtml(title)}\nЗа сьогодні <b>+${money(total)}</b>\nЗібрано <b>${money(balance)}</b>${goal?` із ${money(goal)}`:''}`;}
function goalText(title:string,balance:number,goal:number){return `🎉 <b>Ціль збору досягнуто!</b>\n${balanceLine(title,balance,goal)}\nДякуємо всім за підтримку!`;}
export async function monoCallback(env:Env,q:Callback){
  if(!q.data?.startsWith('mono:'))return false;
  await answer(env,q.id,'');
  if(!admin(env,q.from.id)||q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id)return true;
  const [,action,nonce,extra]=q.data.split(':');
  if(['pause','edit','remove','delete'].includes(action)){
    const f=await env.HOME_DB.prepare('SELECT * FROM mono_funds WHERE id=?').bind(nonce).first<Fund>();
    if(!f)return true;
    if(action==='pause'){
      await env.HOME_DB.prepare('UPDATE mono_funds SET active=1-active WHERE id=?').bind(f.id).run();
      await fundCard(env,{...f,active:1-f.active});return true;
    }
    if(action==='remove'){
      const n=id();await env.HOME_DB.prepare("INSERT INTO mono_setup(user_id,nonce,step,jar_id,expires_at) VALUES (?,?,'delete',?,unixepoch()+300) ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce,step='delete',jar_id=excluded.jar_id,expires_at=excluded.expires_at").bind(q.from.id,n,f.id).run();
      await send(env,q.from.id,`Відключити банку «${f.title}»?`,[[{text:'Відключити',callback_data:`mono:confirmdelete:${n}`}],[{text:'Залишити',callback_data:`mono:cancel:${n}`}]]);return true;
    }
    if(action==='edit'){
      const n=id();await env.HOME_DB.prepare("INSERT INTO mono_setup(user_id,nonce,step,connection_id,jar_id,chat_id,deposits,daily,goal_notice,expires_at) VALUES (?,?,'settings',?,?,?,?,?,?,unixepoch()+900) ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce,step='settings',connection_id=excluded.connection_id,jar_id=excluded.jar_id,chat_id=excluded.chat_id,deposits=excluded.deposits,daily=excluded.daily,goal_notice=excluded.goal_notice,expires_at=excluded.expires_at").bind(q.from.id,n,f.connection_id,f.jar_id,f.chat_id,f.deposits,f.daily,f.goal_notice).run();
      const s=await setupFor(env,n);await send(env,q.from.id,'Які повідомлення надсилати?',settingsButtons(s!));return true;
    }
    return true;
  }
  let s=await setupFor(env,nonce);
  if(!s){await send(env,q.from.id,'Цей крок застарів. Відкрийте «Банки monobank» знову.');return true;}
  if(action==='cancel'){await clearMonoSetup(env);return true;}
  if(action==='confirmdelete'&&s.step==='delete'){
    await env.HOME_DB.batch([
      env.HOME_DB.prepare('DELETE FROM mono_outbox WHERE fund_id=?').bind(s.jar_id),
      env.HOME_DB.prepare('DELETE FROM mono_operations WHERE fund_id=?').bind(s.jar_id),
      env.HOME_DB.prepare('DELETE FROM mono_funds WHERE id=?').bind(s.jar_id),
    ]);await clearMonoSetup(env);await send(env,q.from.id,'Банку відключено.');return true;
  }
  if(action==='jar'&&s.step==='jar'){
    const c=await env.HOME_DB.prepare('SELECT jars FROM mono_connections WHERE id=?').bind(s.connection_id).first<{jars:string}>();
    const j=c&&/^\d+$/.test(extra||'')?(JSON.parse(c.jars) as Jar[])[Number(extra)]:undefined;
    if(!j)return true;
    await env.HOME_DB.prepare("UPDATE mono_setup SET jar_id=?,step='group' WHERE user_id=? AND nonce=?").bind(j.id,q.from.id,nonce).run();
    const groups=await connectedGroups(env);await send(env,q.from.id,'Куди надсилати повідомлення?',groups.map(g=>[{text:g.title.slice(0,60),callback_data:`mono:group:${nonce}:${g.chat_id}`} ]));return true;
  }
  if(action==='group'&&s.step==='group'){
    if(!isConnected(await getGroup(env,Number(extra))))return true;
    await env.HOME_DB.prepare("UPDATE mono_setup SET chat_id=?,step='settings' WHERE user_id=? AND nonce=?").bind(Number(extra),q.from.id,nonce).run();
    s=(await setupFor(env,nonce))!;
  }else if(['deposits','daily','goal_notice'].includes(action)&&s.step==='settings'){
    await env.HOME_DB.prepare(`UPDATE mono_setup SET ${action}=1-${action} WHERE user_id=? AND nonce=?`).bind(q.from.id,nonce).run();s=(await setupFor(env,nonce))!;
  }else if(action==='preview'&&s.step==='settings'){
    if(!s.deposits&&!s.daily&&!s.goal_notice){await send(env,q.from.id,'Оберіть хоча б одне повідомлення.');return true;}
    const j=await chosenJar(env,s);if(!j)return true;
    const g=s.chat_id?await getGroup(env,s.chat_id):null;
    const examples=[s.deposits?depositText(j.title,240000,j.balance,j.goal||0):'',s.daily?dailyText(j.title,240000,j.balance,j.goal||0):'',s.goal_notice?goalText(j.title,j.goal||j.balance,j.goal||0):''].filter(Boolean);
    await sendHtml(env,q.from.id,`Група: ${escapeHtml(g?.title||'')}\n\n${examples.join('\n\n')}\n\nПеревірка — кожні 5 хвилин. Щоденний підсумок — о 20:00 за Києвом.`,[[{text:'Зберегти й увімкнути',callback_data:`mono:save:${nonce}`}]]);return true;
  }else if(action==='save'&&s.step==='settings'){
    const j=await chosenJar(env,s);const g=s.chat_id?await getGroup(env,s.chat_id):null;
    if(!j||!isConnected(g)||(!s.deposits&&!s.daily&&!s.goal_notice))return true;
    await env.HOME_DB.prepare(`INSERT INTO mono_funds(id,connection_id,jar_id,chat_id,group_version,title,balance,goal,deposits,daily,goal_notice,started_at,checked_at,goal_sent) VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch(),?) ON CONFLICT(connection_id,jar_id) DO UPDATE SET chat_id=excluded.chat_id,group_version=excluded.group_version,deposits=excluded.deposits,daily=excluded.daily,goal_notice=excluded.goal_notice,active=1`).bind(id(),s.connection_id,s.jar_id,s.chat_id,g!.version,j.title,j.balance,j.goal||0,s.deposits,s.daily,s.goal_notice,j.goal&&j.balance>=j.goal?1:0).run();
    await clearMonoSetup(env);await send(env,q.from.id,`Банку «${j.title}» підключено. Нові поповнення відстежуємо відтепер.`);await fundsMenu(env);return true;
  }else return true;
  await send(env,q.from.id,'Які повідомлення надсилати?',settingsButtons(s));return true;
}
const dateKyiv=(time:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time*1000));
async function enqueue(env:Env,f:Fund,event:string,text:string){await env.HOME_DB.prepare('INSERT INTO mono_outbox(fund_id,event_key,text) VALUES (?,?,?) ON CONFLICT(fund_id,event_key) DO NOTHING').bind(f.id,event,text).run();}
export async function scheduledMono(env:Env){
  await env.HOME_DB.prepare("DELETE FROM mono_setup WHERE expires_at<=unixepoch() AND step<>'token'").run();
  await env.HOME_DB.prepare('DELETE FROM mono_connections WHERE id NOT IN (SELECT connection_id FROM mono_funds) AND id NOT IN (SELECT connection_id FROM mono_setup WHERE connection_id IS NOT NULL)').run();
  if(!env.MONOBANK_ENCRYPTION_KEY)return;
  const funds=(await env.HOME_DB.prepare('SELECT f.* FROM mono_funds f JOIN groups g ON g.chat_id=f.chat_id WHERE f.active=1 AND g.status=\'approved\' AND g.bot_present=1 AND g.version=f.group_version ORDER BY f.checked_at').all<Fund>()).results;
  for(const f of funds){
    const claim=await env.HOME_DB.prepare('UPDATE mono_connections SET last_request_at=unixepoch() WHERE id=? AND last_request_at<unixepoch()-65').bind(f.connection_id).run();
    if(!claim.meta.changes)continue;
    try{
      const c=await env.HOME_DB.prepare('SELECT * FROM mono_connections WHERE id=?').bind(f.connection_id).first<Connection>();if(!c)continue;
      const end=Math.min(now(),f.checked_at+30*86400);const start=Math.max(f.started_at,f.checked_at-3600);
      const ops=await api<Operation[]>(await decrypt(env,c.token_cipher),`statement/${encodeURIComponent(f.jar_id)}/${start}/${end}`);
      if(!Array.isArray(ops)||ops.some(o=>typeof o.id!=='string'||!Number.isSafeInteger(o.time)||!Number.isSafeInteger(o.amount)||!Number.isSafeInteger(o.balance)))throw new Error('Invalid operations');
      ops.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
      for(const o of ops){
        if(o.hold||o.time<f.started_at)continue;
        // Persist transaction and its notification together, so retries cannot lose an event.
        await recordBankContribution(env,f.id,o,f.deposits&&o.amount>0?{
            legacy:depositText(f.title,o.amount,o.balance,f.goal,o.comment),
            heading:`💸 <b>+${money(o.amount)} у банку</b>\n`,
          }:undefined);
      }
      const latest=ops.filter(o=>!o.hold&&o.time>=f.started_at).at(-1);const balance=latest?.balance??f.balance;
      await env.HOME_DB.prepare("UPDATE mono_funds SET balance=?,checked_at=?,error='' WHERE id=?").bind(balance,end,f.id).run();
      if(f.goal_notice&&!f.goal_sent&&f.goal>0&&balance>=f.goal){
        await enqueue(env,f,'goal',goalText(f.title,balance,f.goal));
        await env.HOME_DB.prepare('UPDATE mono_funds SET goal_sent=1 WHERE id=?').bind(f.id).run();
      }
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
      if(f.daily&&hour>=20&&end>=now()-60){
        const day=dateKyiv(now());
        const total=opsForDay(await env.HOME_DB.prepare('SELECT time,amount FROM mono_operations WHERE fund_id=?').bind(f.id).all<{time:number;amount:number}>(),day);
        await enqueue(env,f,'daily:'+day,dailyText(f.title,total,balance,f.goal));
      }
    }catch{
      const warning=await env.HOME_DB.prepare("UPDATE mono_funds SET error='unavailable' WHERE id=? AND error=''").bind(f.id).run();
      if(warning.meta.changes)await send(env,env.ADMIN_TELEGRAM_USER_ID,`Не вдалося оновити банку «${f.title}». Повторимо перевірку автоматично.`).catch(()=>{});
    }
  }
  const pending=(await env.HOME_DB.prepare(`SELECT o.*,f.chat_id FROM mono_outbox o JOIN mono_funds f ON f.id=o.fund_id JOIN groups g ON g.chat_id=f.chat_id WHERE o.sent_at IS NULL AND o.lease_until<unixepoch() AND f.active=1 AND g.status='approved' AND g.bot_present=1 AND g.version=f.group_version ORDER BY o.id LIMIT 20`).all<{id:number;chat_id:number;text:string}>()).results;
  for(const item of pending){
    const claim=await env.HOME_DB.prepare('UPDATE mono_outbox SET lease_until=unixepoch()+120 WHERE id=? AND sent_at IS NULL AND lease_until<unixepoch()').bind(item.id).run();if(!claim.meta.changes)continue;
    try{await sendHtml(env,item.chat_id,item.text);await env.HOME_DB.prepare('UPDATE mono_outbox SET sent_at=unixepoch() WHERE id=?').bind(item.id).run();}catch{/* Retry after lease. Telegram delivery cannot be exactly-once across network timeouts. */}
  }
}
function opsForDay(rows:{results:{time:number;amount:number}[]},day:string){return rows.results.filter(o=>o.amount>0&&dateKyiv(o.time)===day).reduce((sum,o)=>sum+o.amount,0);}
