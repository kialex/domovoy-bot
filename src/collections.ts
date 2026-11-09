import type { Button, Callback, Env, Message } from './env.ts';
import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import { escapeHtml, kyivDate } from './presentation.ts';
import { answer, send, sendHtml, telegram, TelegramError } from './telegram.ts';
import { intervalLabel, REPOST_INTERVALS, validInterval } from './poll-settings.ts';
import { apartmentNumber, positiveId } from './validation.ts';

export const COLLECTIONS = '💰 Збори';
const PAGE_SIZE = 8;
const money = (amount: number) => new Intl.NumberFormat('uk-UA', {maximumFractionDigits: 2}).format(amount / 100) + ' грн';
interface Collection { id: number; title: string; chat_id: number; closed: number; mono_fund_id: string | null;
  description: string; requested_amount: number | null; bank_card: string | null; bank_url: string | null;
  message_id: number | null; published_hash: string | null; repost_interval: number;
  next_repost_at: number | null; publish_lease_until: number; previous_message_id: number | null;
}
type InputStep = 'title' | 'apartment' | 'allocate' | 'resident_amount' | 'apartment_amount' | 'description' | 'requested' | 'card' | 'bank_url';
interface Person { id: number; name: string }

function button(text: string, callback_data: string): Button[] {
  return [{text, callback_data}];
}

const INPUT_URL = 'https://homebot.invalid/collection/';
const INPUT_LIFETIME = 900;

async function inputKey(env: Env) {
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET),
    {name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}

async function askCollectionInput(env: Env, step: InputStep, target: number, text: string, subject = 0) {
  const expires = Math.floor(Date.now()/1000)+INPUT_LIFETIME;
  const payload = [step,target,subject,expires].join('/');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC',await inputKey(env),
    new TextEncoder().encode(INPUT_URL+payload)));
  const hex = Array.from(signature,byte=>byte.toString(16).padStart(2,'0')).join('');
  await telegram(env,'sendMessage',{
    chat_id:env.ADMIN_TELEGRAM_USER_ID,text,
    entities:[{type:'text_link',offset:0,length:text.length,url:INPUT_URL+payload+'/'+hex}],
    link_preview_options:{is_disabled:true},
    reply_markup:{force_reply:true},
  });
}

async function readCollectionInput(env: Env, url: string) {
  const [step,target,subject,expires,signature,...extra]=url.slice(INPUT_URL.length).split('/');
  if(extra.length||!['title','apartment','allocate','resident_amount','apartment_amount','description','requested','card','bank_url'].includes(step)||
     !/^-?[1-9]\d*$/.test(target)||!/^\d+$/.test(subject)||!/^\d+$/.test(expires)||!/^[a-f0-9]{64}$/.test(signature))return null;
  const deadline=Number(expires);
  if(deadline<Math.floor(Date.now()/1000)||!Number.isSafeInteger(Number(target))||!Number.isSafeInteger(Number(subject)))return null;
  const bytes=Uint8Array.from(signature.match(/../g)!,hex=>parseInt(hex,16));
  const valid=await crypto.subtle.verify('HMAC',await inputKey(env),bytes,new TextEncoder().encode(url.slice(0,-65)));
  return valid?{step:step as InputStep,target_id:Number(target),subject_id:Number(subject)}:null;
}

function findCollection(env: Env, id: number) {
  return env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE c.id=? AND g.status='approved' AND g.bot_present=1`).bind(id).first<Collection>();
}

export async function collectionsMenu(env: Env, page = 0) {
  const {results} = await env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE g.status='approved' AND g.bot_present=1 ORDER BY c.closed,c.id DESC LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE+1,page*PAGE_SIZE).all<Collection>();
  const buttons = results.slice(0,PAGE_SIZE).map(c=>button((c.closed?'🏁 ':'')+c.title,`hc:view:${c.id}`));
  if(page>0)buttons.push(button('← Назад',`hc:list:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:list:${page+1}`));
  buttons.push(button('➕ Створити збір','hc:new'));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,'Збори будинку',buttons);
}

async function collectionCard(env: Env, collection: Collection, page = 0) {
  const {results} = await env.HOME_DB.prepare(`SELECT t.amount,u.name,p.number,p.business_name
    FROM collection_totals t LEFT JOIN profiles u ON u.id=t.profile_id LEFT JOIN premises p ON p.id=t.premise_id
    WHERE t.collection_id=? ORDER BY p.number_start,p.number,u.name,t.rowid LIMIT ? OFFSET ?`)
    .bind(collection.id,PAGE_SIZE+1,page*PAGE_SIZE).all<{amount:number;name:string|null;number:string|null;business_name:string|null}>();
  const rows = results.slice(0,PAGE_SIZE).map(row=>
    `${escapeHtml(row.name || row.business_name || 'Кв. '+row.number)} — ${money(row.amount)}`);
  const buttons: Button[][] = [];
  if(!collection.closed) {
    buttons.push(button('Опис збору',`hc:description:${collection.id}`));
    buttons.push(button('Внесок з квартири',`hc:requested:${collection.id}`));
    if(collection.mono_fund_id)buttons.push(
      button('Посилання на банку',`hc:bank_url:${collection.id}`),
      button('Номер картки банки',`hc:card:${collection.id}`));

    buttons.push(button(collection.message_id?'Налаштувати підняття':'📣 Опублікувати в чаті',`hc:publish:${collection.id}`));
    if(collection.message_id)buttons.push(button('Підняти в чаті',`hc:raise:${collection.id}`));
    buttons.push(button('Додати внесок',`hc:add:${collection.id}`));
    buttons.push(button('Прив’язати банку',`hc:banks:${collection.id}`));
    buttons.push(button('Завершити збір',`hc:finish:${collection.id}`));
  }
  const {total,goal,url}=await collectionProgress(env,collection);
  const progress=money(total)+(goal>0?' із '+money(goal):'');
  if(url&&!collection.closed)buttons.push([{text:'Поповнити банку',url}]);
  if(collection.mono_fund_id||await env.HOME_DB.prepare(
    'SELECT 1 FROM mono_operations WHERE collection_id=? AND credited_premise_id IS NULL LIMIT 1'
  ).bind(collection.id).first())buttons.push(button('Нерозподілені внески',`hc:unmatched:${collection.id}`));
  if(collection.mono_fund_id)buttons.push(button('Перенести внесок на мешканця',`hc:transfers:${collection.id}`));
  if(page>0)buttons.push(button('← Назад',`hc:view:${collection.id}:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:view:${collection.id}:${page+1}`));
  await sendHtml(env,env.ADMIN_TELEGRAM_USER_ID,
    `💰 <b>${escapeHtml(collection.title)}</b>${collection.closed?' · Завершено':''}\nЗібрано — <b>${progress}</b>${rows.length?'\n\n'+rows.join('\n'):''}`,buttons);
}

export async function collectionCallback(env: Env, q: Callback) {
  if(!q.data?.startsWith('hc:'))return false;
  await answer(env,q.id,'');
  if(q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id||String(q.from.id)!==env.ADMIN_TELEGRAM_USER_ID)return true;
  const [,action,raw,extra] = q.data.split(':');
  const page = Number(extra||0);
  if(action==='list') {
    if(/^\d{1,5}$/.test(raw))await collectionsMenu(env,Number(raw));
    return true;
  }
  if(action==='new') {
    const groups=await connectedGroups(env);
    await send(env,q.from.id,'Оберіть будинок для збору.',groups.map(g=>button(g.title.slice(0,60),`hc:house:${g.chat_id}`)));
    return true;
  }
  if(action==='house') {
    const chat=groupId(raw);
    if(chat&&isConnected(await getGroup(env,chat))) {
      await askCollectionInput(env,'title',chat,'Напишіть назву збору.');
    }
    return true;
  }
  const id=positiveId(raw);
  const collection=id&&await findCollection(env,id);
  if(!collection)return true;
  if(action==='view'&&Number.isSafeInteger(page)&&page>=0&&page<=10000) {
    await collectionCard(env,collection,page);
  }
  if(action==='unmatched')await unmatched(env,collection,page);
  if(action==='allocate') {
    const operation=positiveId(extra);
    if(operation) {
      await askCollectionInput(env,'allocate',collection.id,'Напишіть номер квартири для цього внеску.',operation);
    }
  }
  if(action==='transfers'||action==='payer'||action==='move') {
    await transferAction(env,collection,action,extra,q.data.split(':')[4]);
    return true;
  }
  if(collection.closed)return true;
  if(action==='description'||action==='requested'||action==='card'||action==='bank_url') {
    const prompts={description:'Напишіть опис збору або «—», щоб прибрати його.',
      requested:'Напишіть фіксований внесок з квартири в гривнях.',
      card:'Напишіть 16 цифр картки банки або «—», щоб прибрати номер.',
      bank_url:'Надішліть посилання на банку monobank.'};
    await askCollectionInput(env,action,collection.id,prompts[action]);
  }
  if(action==='publish') {
    await send(env,q.from.id,'Як часто піднімати збір?',
      REPOST_INTERVALS.map(interval=>button(intervalLabel(interval),`hc:interval:${collection.id}:${interval}`)));
  }
  if(action==='interval'&&/^\d+$/.test(extra||'')&&validInterval(page)) {
    const group=await getGroup(env,collection.chat_id);
    await telegram(env,'sendMessage',{chat_id:q.from.id,...collectionPostFormat,text:`Чат: <b>${escapeHtml(group?.title||'')}</b>\n${intervalLabel(page)}\n\n${await publicCollectionText(env,collection)}`,
      reply_markup:{inline_keyboard:[button(collection.message_id?'Зберегти інтервал':'Опублікувати',`hc:confirm:${collection.id}:${page}`)]}});
  }
  if(action==='confirm'&&/^\d+$/.test(extra||'')&&validInterval(page)) {
    if(collection.requested_amount===null) {
      await send(env,q.from.id,'Спочатку вкажіть внесок з квартири.',[button('Вказати внесок',`hc:requested:${collection.id}`)]);
    } else if(collection.message_id) {
      await env.HOME_DB.prepare(`UPDATE house_collections SET repost_interval=?,next_repost_at=CASE WHEN ?>0 THEN unixepoch()+? END
        WHERE id=? AND closed=0`).bind(page,page,page,collection.id).run();
      await send(env,q.from.id,'Інтервал збережено.');
    } else {
      await send(env,q.from.id,await publishCollection(env,collection,page)?'Збір опубліковано.':'Публікація вже виконується або збір недоступний.');
    }
  }
  if(action==='raise'&&collection.message_id) {
    await send(env,q.from.id,await publishCollection(env,collection,collection.repost_interval)?'Збір піднято.':'Публікація вже виконується або збір недоступний.');
  }
  if(action==='add') {
    await askCollectionInput(env,'apartment',collection.id,'Напишіть номер квартири.');
  }
  if(action==='person'||action==='apartment') {
    const subject=positiveId(extra);
    if(!subject)return true;
    const recipient=action==='person'
      ? await env.HOME_DB.prepare(`SELECT u.name FROM profiles u JOIN memberships m ON m.profile_id=u.id
        JOIN premises p ON p.id=m.premise_id WHERE u.id=? AND p.chat_id=? AND m.status IN ('approved','pending') LIMIT 1`)
        .bind(subject,collection.chat_id).first<{name:string}>()
      : await env.HOME_DB.prepare("SELECT 'Кв. '||number AS name FROM premises WHERE id=? AND chat_id=? AND kind='apartment'")
        .bind(subject,collection.chat_id).first<{name:string}>();
    if(!recipient)return true;
    await askCollectionInput(env,action==='person'?'resident_amount':'apartment_amount',collection.id,
      `${collection.title} · ${recipient.name}\nНапишіть суму внеску в гривнях.`,subject);
  }
  if(action==='finish')await send(env,q.from.id,`Завершити збір «${collection.title}»?`,[button('Завершити',`hc:close:${collection.id}`),button('Залишити відкритим',`hc:view:${collection.id}`)]);
  if(action==='close') {
    await env.HOME_DB.prepare('UPDATE house_collections SET closed=1,next_repost_at=NULL,published_hash=NULL WHERE id=?').bind(collection.id).run();
    if(collection.message_id)await refreshCollectionPost(env,{...collection,closed:1,published_hash:null}).catch(()=>{});
    await collectionCard(env,{...collection,closed:1});
  }
  if(action==='banks') {
    const {results}=await env.HOME_DB.prepare(`SELECT f.id,f.title FROM mono_funds f WHERE f.chat_id=? AND f.active=1
      AND NOT EXISTS (SELECT 1 FROM house_collections c WHERE c.mono_fund_id=f.id AND c.id!=?) ORDER BY f.title`)
      .bind(collection.chat_id,collection.id).all<{id:string;title:string}>();
    await send(env,q.from.id,results.length?'Оберіть банку для збору.':'Для цього будинку немає вільних підключених банок.',
      results.map(f=>button(f.title.slice(0,60),`hc:link:${collection.id}:${f.id}`)));
  }
  if(action==='link'&&extra) {
    const changed=await env.HOME_DB.prepare(`UPDATE house_collections SET bank_linked_at=CASE WHEN mono_fund_id=? THEN bank_linked_at ELSE unixepoch() END,
      bank_card=CASE WHEN mono_fund_id=? THEN bank_card END, bank_url=CASE WHEN mono_fund_id=? THEN bank_url END, mono_fund_id=? WHERE id=? AND closed=0
      AND EXISTS (SELECT 1 FROM mono_funds WHERE id=? AND chat_id=house_collections.chat_id AND active=1)
      AND NOT EXISTS (SELECT 1 FROM house_collections WHERE mono_fund_id=? AND id!=?)`)
      .bind(extra,extra,extra,extra,collection.id,extra,extra,collection.id).run();
    if(changed.meta.changes)await send(env,q.from.id,'Банку прив’язано. Нові внески з номером квартири в коментарі зараховуватимуться автоматично.');
  }
  return true;
}

async function transferAction(env: Env, collection: Collection, action: string, raw?: string, selected?: string) {
  const uid=env.ADMIN_TELEGRAM_USER_ID;
  if(action==='transfers') {
    const page=Number(raw||0);
    if(!Number.isSafeInteger(page)||page<0||page>10000)return;
    const {results}=await env.HOME_DB.prepare(`SELECT o.rowid AS id,o.amount,o.time,p.number
      FROM mono_operations o JOIN premises p ON p.id=o.credited_premise_id
      WHERE o.collection_id=? AND o.credited_profile_id IS NULL AND o.amount>0
      ORDER BY o.time DESC,o.rowid DESC LIMIT ? OFFSET ?`)
      .bind(collection.id,PAGE_SIZE+1,page*PAGE_SIZE).all<{id:number;amount:number;time:number;number:string}>();
    const buttons=results.slice(0,PAGE_SIZE).map(o=>button(
      `Кв. ${o.number} · ${money(o.amount)} · ${kyivDate(o.time)}`,`hc:payer:${collection.id}:${o.id}`));
    if(page>0)buttons.push(button('← Назад',`hc:transfers:${collection.id}:${page-1}`));
    if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:transfers:${collection.id}:${page+1}`));
    await send(env,uid,results.length?'Оберіть внесок квартири.':'Внесків для перенесення немає.',buttons);
    return;
  }
  const operationId=positiveId(raw);
  if(!operationId)return;
  const operation=await env.HOME_DB.prepare(`SELECT o.credited_premise_id AS premise_id,o.amount,p.number
    FROM mono_operations o JOIN premises p ON p.id=o.credited_premise_id
    WHERE o.rowid=? AND o.collection_id=? AND o.credited_profile_id IS NULL AND o.amount>0`)
    .bind(operationId,collection.id).first<{premise_id:number;amount:number;number:string}>();
  if(!operation) {
    await send(env,uid,'Внесок уже перенесено або він недоступний.');
    return;
  }
  if(action==='payer') {
    const {results}=await env.HOME_DB.prepare(`SELECT u.id,u.name FROM memberships m JOIN profiles u ON u.id=m.profile_id
      WHERE m.premise_id=? AND m.status IN ('approved','pending') ORDER BY u.name`).bind(operation.premise_id).all<Person>();
    await send(env,uid,`Кв. ${operation.number} · ${money(operation.amount)}. Кому зарахувати внесок?`,
      results.map(person=>button(person.name.slice(0,60),`hc:move:${collection.id}:${operationId}:${person.id}`)));
    return;
  }
  const profileId=positiveId(selected);
  if(!profileId)return;
  const eligible=`EXISTS (SELECT 1 FROM mono_operations o JOIN memberships m ON m.premise_id=o.credited_premise_id
    WHERE o.rowid=? AND o.collection_id=? AND o.credited_premise_id=? AND o.credited_profile_id IS NULL
      AND m.profile_id=? AND m.status IN ('approved','pending'))`;
  const guard=[operationId,collection.id,operation.premise_id,profileId] as const;
  const results=await env.HOME_DB.batch([
    env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,profile_id,amount)
      SELECT ?,?,? WHERE ${eligible} ON CONFLICT(collection_id,profile_id) DO UPDATE SET amount=amount+excluded.amount`)
      .bind(collection.id,profileId,operation.amount,...guard),
    env.HOME_DB.prepare(`DELETE FROM collection_totals WHERE collection_id=? AND premise_id=? AND amount=? AND ${eligible}`)
      .bind(collection.id,operation.premise_id,operation.amount,...guard),
    env.HOME_DB.prepare(`UPDATE collection_totals SET amount=amount-? WHERE collection_id=? AND premise_id=? AND ${eligible}`)
      .bind(operation.amount,collection.id,operation.premise_id,...guard),
    env.HOME_DB.prepare(`UPDATE mono_operations SET credited_profile_id=? WHERE rowid=? AND ${eligible}`)
      .bind(profileId,operationId,...guard),
  ]);
  await send(env,uid,results[0].meta.changes?'Внесок перенесено на мешканця.':'Внесок недоступний для перенесення.');
}

async function collectionProgress(env: Env, collection: Collection) {
  const bank=collection.mono_fund_id&&await env.HOME_DB.prepare(`SELECT f.jar_id,f.balance,f.goal,c.jars FROM mono_funds f
    JOIN mono_connections c ON c.id=f.connection_id WHERE f.id=?`).bind(collection.mono_fund_id)
    .first<{jar_id:string;balance:number;goal:number;jars:string}>();
  if(bank) {
    const jars=JSON.parse(bank.jars) as {id:string;sendId?:string}[];
    const sendId=jars.find(jar=>jar.id===bank.jar_id)?.sendId;
    return {total:bank.balance,goal:bank.goal,url:collection.bank_url||(sendId&&/^[a-zA-Z0-9_-]+$/.test(sendId)
      ?'https://send.monobank.ua/jar/'+sendId:null)};
  }
  const total=await env.HOME_DB.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM collection_totals WHERE collection_id=?')
    .bind(collection.id).first<{amount:number}>();
  return {total:total?.amount??0,goal:0,url:null};
}

async function publicCollectionText(env: Env, collection: Collection) {
  const {total,goal,url}=await collectionProgress(env,collection);
  const figures:string[]=[];
  if(collection.requested_amount!==null)figures.push(`💰 Внесок з квартири — <b>${money(collection.requested_amount)}</b>`);
  if(goal>0)figures.push(`🎯 Ціль банки — <b>${money(goal)}</b>`);
  figures.push(`Зібрано — <b>${money(total)}</b>`);
  const blocks=[`<b>${escapeHtml(collection.title)}</b>${collection.closed?' · Завершено':''}`];
  if(collection.description)blocks.push(escapeHtml(collection.description));
  blocks.push(figures.join('\n'));
  if(!collection.closed&&collection.mono_fund_id) {
    if(url)blocks.push(`🔗 Посилання на банку\n<a href="${url}">${url}</a>`);
    if(collection.bank_card)blocks.push(`💳 Номер картки банки\n<code>${escapeHtml(collection.bank_card.replace(/(.{4})(?=.)/g,'$1 '))}</code>`);
    if(url||collection.bank_card)blocks.push('Будь ласка, вкажіть номер квартири в коментарі до поповнення, щоб внесок автоматично зарахувався вашій квартирі. Наприклад, <code>кв. 25</code>.');
  }
  return blocks.join('\n\n');
}

async function collectionPostHash(text: string) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

const collectionPostFormat={parse_mode:'HTML',link_preview_options:{is_disabled:true}};

async function deleteCollectionPost(env: Env, chatId: number, messageId: number) {
  try {
    await telegram(env,'deleteMessage',{chat_id:chatId,message_id:messageId});
  } catch(error) {
    if(!(error instanceof TelegramError)||!['not_found','cannot_delete'].includes(error.reason))throw error;
  }
}

async function cleanPreviousPost(env: Env, collection: Collection) {
  if(!collection.previous_message_id)return;
  await deleteCollectionPost(env,collection.chat_id,collection.previous_message_id);
  await env.HOME_DB.prepare('UPDATE house_collections SET previous_message_id=NULL WHERE id=? AND previous_message_id=?')
    .bind(collection.id,collection.previous_message_id).run();
}

async function publishCollection(env: Env, collection: Collection, interval: number, scheduled=false) {
  const lease=Math.floor(Date.now()/1000)+120;
  const claimed=await env.HOME_DB.prepare(`UPDATE house_collections SET publish_lease_until=?
    WHERE id=? AND closed=0 AND message_id IS ? AND publish_lease_until<=unixepoch()
      AND (?=0 OR (next_repost_at IS NOT NULL AND next_repost_at<=unixepoch()))`)
    .bind(lease,collection.id,collection.message_id,Number(scheduled)).run();
  if(!claimed.meta.changes)return false;
  try {
    const latest=await findCollection(env,collection.id);
    if(!latest||latest.closed||latest.requested_amount===null)return false;
    await cleanPreviousPost(env,latest);
    const text=await publicCollectionText(env,latest);
    const sent=await telegram<{message_id:number}>(env,'sendMessage',{chat_id:latest.chat_id,text,...collectionPostFormat});
    const saved=await env.HOME_DB.prepare(`UPDATE house_collections SET previous_message_id=message_id,
      message_id=?,published_hash=?,repost_interval=?,next_repost_at=CASE WHEN ?>0 THEN unixepoch()+? END
      WHERE id=? AND closed=0 AND publish_lease_until=?`).bind(sent.message_id,await collectionPostHash(text),interval,interval,interval,latest.id,lease).run();
    if(!saved.meta.changes) {
      await deleteCollectionPost(env,latest.chat_id,sent.message_id);
      return false;
    }
    await cleanPreviousPost(env,{...latest,previous_message_id:latest.message_id}).catch(()=>{});
    return true;
  } finally {
    await env.HOME_DB.prepare('UPDATE house_collections SET publish_lease_until=0 WHERE id=? AND publish_lease_until=?')
      .bind(collection.id,lease).run();
  }
}

async function refreshCollectionPost(env: Env, collection: Collection) {
  const text=await publicCollectionText(env,collection);
  const hash=await collectionPostHash(text);
  if(hash===collection.published_hash)return;
  try {
    await telegram(env,'editMessageText',{chat_id:collection.chat_id,message_id:collection.message_id,text,...collectionPostFormat});
  } catch(error) {
    if(!(error instanceof TelegramError)||error.reason!=='not_found')throw error;
    return;
  }
  await env.HOME_DB.prepare('UPDATE house_collections SET published_hash=? WHERE id=? AND message_id=? AND closed=?')
    .bind(hash,collection.id,collection.message_id,collection.closed).run();
}

export async function scheduledCollections(env: Env) {
  const {results}=await env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE c.message_id IS NOT NULL AND g.status='approved' AND g.bot_present=1
      AND (c.closed=0 OR c.published_hash IS NULL OR c.previous_message_id IS NOT NULL)`).all<Collection>();
  for(const collection of results) {
    try {
      await cleanPreviousPost(env,collection);
      if(collection.closed) {
        if(collection.published_hash===null)await refreshCollectionPost(env,collection);
        continue;
      }
      if(collection.next_repost_at!==null&&collection.next_repost_at<=Math.floor(Date.now()/1000)) {
        await publishCollection(env,collection,collection.repost_interval,true);
      } else if(collection.publish_lease_until<=Math.floor(Date.now()/1000)) {
        await refreshCollectionPost(env,collection);
      }
    } catch {
      console.error('Collection post update failed', {collectionId:collection.id});
    }
  }
}

function amountInKopiykas(text: string) {
  const clean=text.replace(/\s/g,'');
  if(!/^\d{1,9}([.,]\d{1,2})?$/.test(clean))return null;
  const [whole,fraction='']=clean.split(/[.,]/);
  const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return amount>0?amount:null;
}

export async function collectionMessage(env: Env, message: Message, updateId: number) {
  if(message.chat.type!=='private'||String(message.from?.id)!==env.ADMIN_TELEGRAM_USER_ID||!message.text)return false;
  const uid=message.from!.id;
  const reply=message.reply_to_message;
  const url=reply?.from?.is_bot&&reply.entities?.find(entity=>entity.type==='text_link'&&entity.url?.startsWith(INPUT_URL))?.url;
  if(!url)return false;
  const current=await readCollectionInput(env,url);
  if(!current) {
    await send(env,uid,'Цей запит застарів. Відкрийте збір і повторіть дію.');
    return true;
  }
  const value=message.text.trim();
  if(current.step==='title') {
    if(!value||value.length>80||value.includes('\n')) {
      await askCollectionInput(env,'title',current.target_id,'Напишіть назву збору до 80 символів.');
      return true;
    }
    if(!isConnected(await getGroup(env,current.target_id))) {
      await send(env,uid,'Будинок недоступний.');
      return true;
    }
    const result=await env.HOME_DB.batch([
      env.HOME_DB.prepare('INSERT INTO house_collections(chat_id,title) VALUES (?,?)').bind(current.target_id,value),
      env.HOME_DB.prepare("UPDATE updates SET state='done' WHERE id=?").bind(updateId),
    ]);
    const collection=await findCollection(env,Number(result[0].meta.last_row_id));
    if(collection)await collectionCard(env,collection);
    return true;
  }
  const collection=await findCollection(env,current.target_id);
  if(!collection||(collection.closed&&current.step!=='allocate')) {
    await send(env,uid,'Збір недоступний для внесків.');
    return true;
  }
  if(current.step==='description'||current.step==='requested'||current.step==='card'||current.step==='bank_url') {
    const step=current.step;
    const column={description:'description',requested:'requested_amount',card:'bank_card',bank_url:'bank_url'}[step];
    const card=value.replace(/\s/g,'');
    const updated=step==='description'?(value==='—'?'':value):step==='requested'?amountInKopiykas(value):step==='bank_url'?value:value==='—'?null:card;
    if((step==='description'&&value.length>1000)||(step==='requested'&&updated===null)||
       (step==='card'&&(!collection.mono_fund_id||(updated!==null&&!/^\d{16}$/.test(card))))||
       (step==='bank_url'&&(!collection.mono_fund_id||!/^https:\/\/send\.monobank\.ua\/jar\/[a-zA-Z0-9_-]{1,80}$/.test(value)))) {
      await askCollectionInput(env,step,collection.id,'Перевірте формат і спробуйте ще раз.');
      return true;
    }
    await env.HOME_DB.prepare(`UPDATE house_collections SET ${column}=? WHERE id=? AND closed=0`).bind(updated,collection.id).run();
    const saved=await findCollection(env,collection.id);
    if(saved)await collectionCard(env,saved);
    return true;
  }
  if(current.step==='apartment'||current.step==='allocate') {
    const number=apartmentNumber(value);
    const premise=number&&await env.HOME_DB.prepare("SELECT id FROM premises WHERE chat_id=? AND kind='apartment' AND number=?")
      .bind(collection.chat_id,number).first<{id:number}>();
    if(!premise) {
      await askCollectionInput(env,current.step,collection.id,'Квартиру не знайдено. Напишіть номер ще раз.',current.subject_id);
      return true;
    }
    if(current.step==='allocate') {
      await allocateBankContribution(env,collection.id,current.subject_id!,premise.id);
        await collectionCard(env,collection);
      return true;
    }
    const {results}=await env.HOME_DB.prepare(`SELECT u.id,u.name FROM memberships m JOIN profiles u ON u.id=m.profile_id
      WHERE m.premise_id=? AND m.status IN ('approved','pending') ORDER BY u.name,u.id`).bind(premise.id).all<Person>();
    await send(env,uid,'Кому зарахувати внесок?',[
      button('Квартирі '+number,`hc:apartment:${collection.id}:${premise.id}`),
      ...results.map(person=>button(person.name.slice(0,60),`hc:person:${collection.id}:${person.id}`)),
    ]);
    return true;
  }
  if(current.step!=='resident_amount'&&current.step!=='apartment_amount')return false;
  const amount=amountInKopiykas(value);
  if(!amount) {
    await askCollectionInput(env,current.step,collection.id,'Введіть суму, наприклад 1500 або 1500,50.',current.subject_id);
    return true;
  }
  const resident=current.step==='resident_amount';
  const column=resident?'profile_id':'premise_id';
  const subject=current.subject_id!;
  const eligibility=resident
    ? "EXISTS (SELECT 1 FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.profile_id=? AND p.chat_id=c.chat_id AND m.status IN ('approved','pending'))"
    : 'EXISTS (SELECT 1 FROM premises p WHERE p.id=? AND p.chat_id=c.chat_id)';
  const results=await env.HOME_DB.batch([
    env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,${column},amount)
      SELECT c.id,?,? FROM house_collections c WHERE c.id=? AND c.closed=0 AND ${eligibility}
      AND EXISTS (SELECT 1 FROM updates WHERE id=? AND state='processing')
      ON CONFLICT(collection_id,${column}) DO UPDATE SET amount=amount+excluded.amount`)
      .bind(subject,amount,collection.id,subject,updateId),
    env.HOME_DB.prepare("UPDATE updates SET state='done' WHERE id=?").bind(updateId),
  ]);
  if(!results[0].meta.changes)await send(env,uid,'Не вдалося зарахувати внесок.');
  else await collectionCard(env,collection);
  return true;
}

async function unmatched(env: Env, collection: Collection, page: number) {
  if(!Number.isSafeInteger(page)||page<0||page>10000)return;
  const {results}=await env.HOME_DB.prepare(`SELECT rowid AS id,amount,time,collection_comment FROM mono_operations
    WHERE collection_id=? AND credited_premise_id IS NULL ORDER BY time DESC,rowid DESC LIMIT ? OFFSET ?`)
    .bind(collection.id,PAGE_SIZE+1,page*PAGE_SIZE).all<{id:number;amount:number;time:number;collection_comment:string|null}>();
  const buttons=results.slice(0,PAGE_SIZE).map(o=>button(
    [money(o.amount),kyivDate(o.time),o.collection_comment].filter(Boolean).join(' · ').slice(0,80),`hc:allocate:${collection.id}:${o.id}`));
  if(page>0)buttons.push(button('← Назад',`hc:unmatched:${collection.id}:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:unmatched:${collection.id}:${page+1}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,results.length?'Оберіть внесок, щоб зарахувати його квартирі.':'Нерозподілених внесків немає.',buttons);
}

async function allocateBankContribution(env: Env, collectionId: number, operationId: number, premiseId: number) {
  await env.HOME_DB.batch([
    env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,premise_id,amount)
      SELECT collection_id,?,amount FROM mono_operations WHERE rowid=? AND collection_id=? AND credited_premise_id IS NULL AND amount>0
      ON CONFLICT(collection_id,premise_id) DO UPDATE SET amount=amount+excluded.amount`).bind(premiseId,operationId,collectionId),
    env.HOME_DB.prepare(`UPDATE mono_operations SET credited_premise_id=?
      WHERE rowid=? AND collection_id=? AND credited_premise_id IS NULL AND amount>0`).bind(premiseId,operationId,collectionId),
  ]);
}

export async function residentCollectionLines(env: Env, uid: number) {
  const {results}=await env.HOME_DB.prepare(`SELECT c.title,t.collection_id,
      SUM(CASE WHEN t.profile_id IS NOT NULL THEN t.amount ELSE 0 END) AS personal,
      SUM(CASE WHEN t.premise_id IS NOT NULL THEN t.amount ELSE 0 END) AS apartment
    FROM collection_totals t JOIN house_collections c ON c.id=t.collection_id
    JOIN groups g ON g.chat_id=c.chat_id
    WHERE g.status='approved' AND g.bot_present=1
      AND EXISTS (SELECT 1 FROM memberships m JOIN premises p ON p.id=m.premise_id
        JOIN profiles u ON u.id=m.profile_id
        WHERE u.user_id=? AND m.status='approved' AND p.chat_id=c.chat_id
          AND (t.profile_id=m.profile_id OR t.premise_id=p.id))
    GROUP BY c.id ORDER BY c.closed,c.id DESC LIMIT 20`).bind(uid)
    .all<{title:string;personal:number;apartment:number}>();
  return results.map(row=>{
    const personal=row.personal?money(row.personal):'';
    const apartment=row.apartment?money(row.apartment)+' (внесок квартири)':'';
    return `${escapeHtml(row.title)} — <b>${[personal,apartment].filter(Boolean).join(' · ')}</b>`;
  }).join('\n');
}

export function bankContributionStatements(env: Env, fundId: string, operation: {
  id: string; time: number; amount: number; comment?: string;
}, notification?: {legacy:string;heading:string}) {
  const comment=typeof operation.comment==='string'?operation.comment.replace(/\s+/g,' ').trim().slice(0,300):'';
  const matches=[...comment.matchAll(/(?<![\p{L}\p{N}])(?:кв\.?|квартира)\s*№?\s*(\d{1,3}\s*[аa]?)(?![\p{L}\p{N}/-])/giu)];
  const numbers=new Set(matches.map(match=>apartmentNumber(match[1].replace(/\s/g,''))));
  const number=numbers.size===1?[...numbers][0]:null;
  const statements: D1PreparedStatement[]=[];
  const link=`c.mono_fund_id=f.id AND c.closed=0 AND c.chat_id=f.chat_id AND c.bank_linked_at<=? AND ?>0`;
  if(notification)statements.push(env.HOME_DB.prepare(`INSERT INTO mono_outbox(fund_id,event_key,text)
    SELECT f.id,?,CASE WHEN c.id IS NULL THEN ? ELSE
      ? || replace(replace(replace(c.title,'&','&amp;'),'<','&lt;'),'>','&gt;') ||
      CASE WHEN p.id IS NOT NULL THEN char(10)||'Внесок зараховано квартирі <b>'||p.number||'</b> автоматично' ELSE '' END ||
      char(10)||'Дякуємо за внесок!' END
    FROM mono_funds f LEFT JOIN house_collections c ON ${link}
    LEFT JOIN premises p ON p.chat_id=c.chat_id AND p.kind='apartment' AND p.number=?
    WHERE f.id=? AND NOT EXISTS (SELECT 1 FROM mono_operations WHERE fund_id=f.id AND operation_id=?)
    ON CONFLICT(fund_id,event_key) DO NOTHING`)
    .bind('op:'+operation.id,notification.legacy,notification.heading,operation.time,operation.amount,number,fundId,operation.id));
  if(number&&operation.amount>0)statements.push(env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,premise_id,amount)
    SELECT c.id,p.id,? FROM mono_funds f JOIN house_collections c ON ${link}
    JOIN premises p ON p.chat_id=c.chat_id AND p.kind='apartment' AND p.number=?
    WHERE f.id=? AND NOT EXISTS (SELECT 1 FROM mono_operations WHERE fund_id=f.id AND operation_id=?)
    ON CONFLICT(collection_id,premise_id) DO UPDATE SET amount=amount+excluded.amount`)
    .bind(operation.amount,operation.time,operation.amount,number,fundId,operation.id));
  statements.push(env.HOME_DB.prepare(`INSERT INTO mono_operations(fund_id,operation_id,time,amount,collection_id,credited_premise_id,collection_comment)
    SELECT f.id,?,?,?,c.id,p.id,CASE WHEN c.id IS NOT NULL THEN ? END
    FROM mono_funds f LEFT JOIN house_collections c ON ${link}
    LEFT JOIN premises p ON p.chat_id=c.chat_id AND p.kind='apartment' AND p.number=?
    WHERE f.id=? ON CONFLICT(fund_id,operation_id) DO NOTHING`)
    .bind(operation.id,operation.time,operation.amount,comment||null,operation.time,operation.amount,number,fundId));
  return statements;
}
