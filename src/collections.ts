import { syncCollectionVotes } from './collection-votes.ts';
import { residentTree } from './resident-tree.ts';
import type { Button, Callback, Env, Message } from './env.ts';
import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import { escapeHtml, kyivDate } from './presentation.ts';
import { answer, send, sendHtml, telegram, TelegramError } from './telegram.ts';
import { intervalLabel, REPOST_INTERVALS, validInterval } from './poll-settings.ts';
import { apartmentNumber, positiveId } from './validation.ts';

export const COLLECTIONS = '💰 Збори';
const PAGE_SIZE = 8;
const premiseContributionLabel = "CASE WHEN kind='commercial' THEN business_name ELSE 'Кв. '||number END";
const money = (amount: number) => new Intl.NumberFormat('uk-UA', {maximumFractionDigits: 2}).format(amount / 100) + ' грн';
interface Collection { vote_poll_id: number|null; vote_option_index:number|null; id: number; title: string; chat_id: number; closed: number; mono_fund_id: string | null;
  description: string; requested_amount: number | null; bank_card: string | null; bank_url: string | null;
  message_id: number | null; published_hash: string | null; repost_interval: number;
  next_repost_at: number | null; publish_lease_until: number; previous_message_id: number | null;
}
type InputStep = 'title' | 'apartment' | 'allocate' | 'resident_amount' | 'apartment_amount' | 'description' | 'requested' | 'card' | 'bank_url';
interface Person { id: number; name: string }

function button(text: string, callback_data: string): Button[] {
  return [{text, callback_data}];
}

interface CollectionInput {
  step: InputStep;
  target_id: number;
  subject_id: number;
  guided: boolean;
  expires: number;
  token: string;
}

export async function clearCollectionInput(env: Env) {
  await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=NULL WHERE user_id=? AND collection_input IS NOT NULL')
    .bind(env.ADMIN_TELEGRAM_USER_ID).run();
}

async function askCollectionInput(env: Env, step: InputStep, target: number, text: string, subject = 0, guided = false) {
  const token = crypto.randomUUID().slice(0,12);
  const input: CollectionInput = {
    step,target_id:target,subject_id:subject,guided,expires:Math.floor(Date.now()/1000)+900,token,
  };
  await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=? WHERE user_id=?')
    .bind(JSON.stringify(input),env.ADMIN_TELEGRAM_USER_ID).run();
  const buttons: Button[][] = [];
  if(guided && ['description','card','bank_url'].includes(step))buttons.push(button('Пропустити',`hc:skip:${token}`));
  buttons.push(button('Скасувати',`hc:cancelinput:${token}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,text,buttons);
}

async function collectionInput(env: Env) {
  const row = await env.HOME_DB.prepare('SELECT collection_input FROM private_chats WHERE user_id=?')
    .bind(env.ADMIN_TELEGRAM_USER_ID).first<{collection_input:string|null}>();
  return row?.collection_input ? {raw:row.collection_input,input:JSON.parse(row.collection_input) as CollectionInput} : null;
}

function findCollection(env: Env, id: number) {
  return env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE c.id=? AND g.status='approved' AND g.bot_present=1`).bind(id).first<Collection>();
}

export async function collectionsMenu(env: Env, page = 0) {
  const {results} = await env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE g.status='approved' AND g.bot_present=1 ORDER BY c.closed,c.id DESC LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE+1,page*PAGE_SIZE).all<Collection>();
  const buttons = [button('➕ Створити збір','hc:new'), ...results.slice(0,PAGE_SIZE).map(c=>
    button((c.closed?'🏁 ':c.message_id?'':'📝 ')+c.title,`hc:view:${c.id}`))];
  if(page>0)buttons.push(button('← Назад',`hc:list:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:list:${page+1}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,results.length?'Оберіть збір або створіть новий.':'Зборів ще немає.',buttons);
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
    buttons.push(button(collection.message_id?'Підняти в чаті':'Переглянути й опублікувати',
      `hc:${collection.message_id?'raise':'publish'}:${collection.id}`));
    buttons.push(button('Налаштування збору',`hc:settings:${collection.id}`));
  }
  buttons.push(button('Зарахувати внесок',`hc:add:${collection.id}`));
  const linkedPoll=collection.vote_poll_id ? await env.HOME_DB.prepare('SELECT question,options FROM polls WHERE id=? AND chat_id=?')
    .bind(collection.vote_poll_id,collection.chat_id).first<{question:string;options:string}>() : null;
  const voteInfo=linkedPoll ? `\n🗳 ${escapeHtml(linkedPoll.question)}\nЗа внеском: ${escapeHtml((JSON.parse(linkedPoll.options) as string[])[collection.vote_option_index!] ?? '')}` : '';
  const {total,goal}=await collectionProgress(env,collection);
  const progress=money(total)+(goal>0?' із '+money(goal):'');
  const pending = collection.mono_fund_id || await env.HOME_DB.prepare(
    'SELECT 1 FROM mono_operations WHERE collection_id=? AND credited_premise_id IS NULL LIMIT 1'
  ).bind(collection.id).first();
  if(pending)buttons.push(button('Внески з банки',`hc:bankpayments:${collection.id}`));
  if(page>0)buttons.push(button('← Назад',`hc:view:${collection.id}:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:view:${collection.id}:${page+1}`));
  await sendHtml(env,env.ADMIN_TELEGRAM_USER_ID,
    `💰 <b>${escapeHtml(collection.title)}</b>${collection.closed?' · Завершено':collection.message_id?' · Опубліковано':' · Чернетка'}\nЗібрано — <b>${progress}</b>${voteInfo}${rows.length?'\n\n'+rows.join('\n'):''}`,buttons);
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
    await clearCollectionInput(env);
    const groups=await connectedGroups(env);
    if(groups.length===1) {
      await askCollectionInput(env,'title',groups[0].chat_id,'Напишіть назву збору.',0,true);
    } else {
      await send(env,q.from.id,groups.length?'У якому чаті буде збір?':'Спочатку підключіть групу.',
        groups.map(g=>button(g.title.slice(0,60),`hc:house:${g.chat_id}`)));
    }
    return true;
  }
  if(action==='house') {
    const chat=groupId(raw);
    if(chat&&isConnected(await getGroup(env,chat)))await askCollectionInput(env,'title',chat,'Напишіть назву збору.',0,true);
    return true;
  }
  if(action==='skip'||action==='cancelinput') {
    const pending = await collectionInput(env);
    if(pending?.input.token!==raw)return true;
    if(action==='cancelinput') {
      await clearCollectionInput(env);
      const collection = pending.input.step==='title'?null:await findCollection(env,pending.input.target_id);
      if(collection)await collectionCard(env,collection);
      else await send(env,q.from.id,'Створення збору скасовано.');
    } else if(pending.input.guided && ['description','card','bank_url'].includes(pending.input.step)) {
      await handleCollectionInput(env,q.from.id,pending,'—',0);
    }
    return true;
  }
  await clearCollectionInput(env);
  if(action==='unit'||action==='history') {
    const premiseId=positiveId(raw);
    if(premiseId&&Number.isSafeInteger(page)&&page>=0&&page<=10000) {
      await premiseCollections(env,premiseId,action,page);
    }
    return true;
  }
  const id=positiveId(raw);
  const collection=id&&await findCollection(env,id);
  if(!collection)return true;
  if(['polls','pollpick','pollchoice','nopoll'].includes(action)) {
    await collectionPollAction(env,collection,action,q.data.split(':').slice(3));
    return true;
  }
  if(action==='settings'&&!collection.closed) {
    await send(env,q.from.id,`Налаштування «${collection.title}»`,[
      button('Змінити опис',`hc:description:${id}`),button('Змінити внесок з квартири',`hc:requested:${id}`),
      button('Обрати банку',`hc:banks:${id}`),button('Пов’язане голосування',`hc:polls:${id}:0`),
      ...(collection.mono_fund_id?[button('Посилання на банку',`hc:bank_url:${id}`),button('Номер картки банки',`hc:card:${id}`)]:[]),
      ...(collection.message_id?[button('Частота підняття',`hc:publish:${id}`)]:[]),
      button('Зарахувати внесок мешканцю',`hc:personadd:${id}`),
      button('Завершити збір',`hc:finish:${id}`),button('До збору',`hc:view:${id}`),
    ]);
    return true;
  }
  if(action==='bankpayments') {
    await send(env,q.from.id,'Внески з банки',[
      button('Зарахувати нерозподілений внесок',`hc:unmatched:${id}`),
      button('Перенести внесок на мешканця',`hc:transfers:${id}`),
      button('До збору',`hc:view:${id}`),
    ]);
    return true;
  }
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
  if(collection.closed&&action!=='add'&&action!=='apartment')return true;
  if(action==='description'||action==='requested'||action==='card'||action==='bank_url') {
    const prompts={description:'Напишіть опис збору або «—», щоб прибрати його.',
      requested:'Напишіть фіксований внесок з квартири в гривнях.',
      card:'Напишіть 16 цифр картки банки або «—», щоб прибрати номер.',
      bank_url:'Надішліть посилання на банку monobank.'};
    await askCollectionInput(env,action,collection.id,prompts[action]);
  }
  if(action==='publish') {
    if(collection.requested_amount===null) {
      await askCollectionInput(env,'requested',collection.id,'Скільки має внести одна квартира? Напишіть суму в гривнях.',0,true);
    } else await chooseCollectionInterval(env,collection);
  }
  if(action==='interval'&&/^\d+$/.test(extra||'')&&validInterval(page)) {
    const group=await getGroup(env,collection.chat_id);
    await telegram(env,'sendMessage',{chat_id:q.from.id,...collectionPostFormat,text:`Чат: <b>${escapeHtml(group?.title||'')}</b>\n${intervalLabel(page)}\n\n${await publicCollectionText(env,collection)}`,
      reply_markup:{inline_keyboard:[button(collection.message_id?'Зберегти інтервал':'Опублікувати',`hc:${collection.message_id?'saveinterval':'confirm'}:${collection.id}:${page}`),button('Змінити частоту',`hc:publish:${collection.id}`),button('До збору',`hc:view:${collection.id}`)]}});
  }
  if((action==='confirm'||action==='saveinterval')&&/^\d+$/.test(extra||'')&&validInterval(page)) {
    if(collection.requested_amount===null) {
      await send(env,q.from.id,'Спочатку вкажіть внесок з квартири.',[button('Вказати внесок',`hc:requested:${collection.id}`)]);
    } else if(action==='saveinterval'&&collection.message_id) {
      await env.HOME_DB.prepare(`UPDATE house_collections SET repost_interval=?,next_repost_at=CASE WHEN ?>0 THEN unixepoch()+? END
        WHERE id=? AND closed=0`).bind(page,page,page,collection.id).run();
      await send(env,q.from.id,'Інтервал збережено.');
    } else if(action==='confirm'&&!collection.message_id) {
      let published: boolean;
      try { published = await publishCollection(env,collection,page); }
      catch {
        await send(env,q.from.id,'Не вдалося опублікувати. Перевірте, чи бот може писати в чат.',[
          button('Спробувати ще раз',`hc:confirm:${collection.id}:${page}`),button('До збору',`hc:view:${collection.id}`),
        ]);
        return true;
      }
      if(published)await send(env,q.from.id,'Збір опубліковано.',[button('До збору',`hc:view:${collection.id}`)]);
      else await send(env,q.from.id,'Збір уже опубліковано або він недоступний.',[button('До збору',`hc:view:${collection.id}`)]);
    }
  }
  if(action==='raise'&&collection.message_id) {
    await send(env,q.from.id,await publishCollection(env,collection,collection.repost_interval)?'Збір піднято.':'Публікація вже виконується або збір недоступний.');
  }
  if(action==='add') {
    await residentTree(env,{chat:collection.chat_id,entrance:'-',floor:'-',unit:0,page:0,collection:collection.id});
  }
  if(action==='personadd') {
    await askCollectionInput(env,'apartment',collection.id,'Напишіть номер квартири.');
  }
  if(action==='person'||action==='apartment') {
    const subject=positiveId(extra);
    if(!subject)return true;
    const recipient=action==='person'
      ? await env.HOME_DB.prepare(`SELECT u.name FROM profiles u JOIN memberships m ON m.profile_id=u.id
        JOIN premises p ON p.id=m.premise_id WHERE u.id=? AND p.chat_id=? AND m.status IN ('approved','pending') LIMIT 1`)
        .bind(subject,collection.chat_id).first<{name:string}>()
      : await env.HOME_DB.prepare(`SELECT ${premiseContributionLabel} AS name FROM premises WHERE id=? AND chat_id=?`)
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
  if(action==='banks')await chooseCollectionBank(env,collection);
  if(action==='link'&&extra) {
    const changed=await env.HOME_DB.prepare(`UPDATE house_collections SET bank_linked_at=CASE WHEN mono_fund_id=? THEN bank_linked_at ELSE unixepoch() END,
      bank_card=CASE WHEN mono_fund_id=? THEN bank_card END, bank_url=CASE WHEN mono_fund_id=? THEN bank_url END, mono_fund_id=? WHERE id=? AND closed=0
      AND EXISTS (SELECT 1 FROM mono_funds WHERE id=? AND chat_id=house_collections.chat_id AND active=1)
      AND NOT EXISTS (SELECT 1 FROM house_collections WHERE mono_fund_id=? AND id!=?)`)
      .bind(extra,extra,extra,extra,collection.id,extra,extra,collection.id).run();
    const guided=q.data.endsWith(':setup');
    const saved=changed.meta.changes&&await findCollection(env,collection.id);
    if(!saved) {
      await send(env,q.from.id,'Ця банка вже недоступна.');
      await chooseCollectionBank(env,collection,guided);
    } else if(guided) {
      if((await collectionProgress(env,saved)).url)await askCollectionCardNumber(env,saved);
      else await askCollectionInput(env,'bank_url',saved.id,'Надішліть посилання на банку.',0,true);
    } else await collectionCard(env,saved);
  }
  return true;
}

interface CollectionPoll {id:number;question:string;options:string}

async function chooseCollectionPoll(env: Env, collection: Collection, page=0, guided=false) {
  if(!Number.isSafeInteger(page)||page<0||page>10000||collection.closed)return;
  const {results}=await env.HOME_DB.prepare(`SELECT p.id,p.question,p.options FROM polls p
    WHERE p.chat_id=? AND p.status='open' AND (p.ends_at IS NULL OR p.ends_at>unixepoch())
    AND NOT EXISTS (SELECT 1 FROM house_collections c WHERE c.vote_poll_id=p.id AND c.id<>?)
    ORDER BY p.id DESC LIMIT ? OFFSET ?`).bind(collection.chat_id,collection.id,PAGE_SIZE+1,page*PAGE_SIZE).all<CollectionPoll>();
  if(guided&&!results.length&&page===0)return chooseCollectionBank(env,collection,true);
  const suffix=guided?':setup':'';
  const buttons=results.slice(0,PAGE_SIZE).map(p=>button(p.question.slice(0,60),`hc:pollpick:${collection.id}:${p.id}${suffix}`));
  if(page>0)buttons.push(button('← Назад',`hc:polls:${collection.id}:${page-1}${suffix}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:polls:${collection.id}:${page+1}${suffix}`));
  buttons.push(button(guided?'Пропустити':'Без голосування',`hc:nopoll:${collection.id}${suffix}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,
    'Яке голосування прив’язати до збору?\nВнесок додасть голос лише від приміщення, яке ще не голосувало. Врахуємо також уже зараховані внески.',buttons);
}

async function collectionPollAction(env: Env, collection: Collection, action: string, args: string[]) {
  if(collection.closed)return;
  const guided=args.at(-1)==='setup';
  if(action==='polls')return chooseCollectionPoll(env,collection,Number(args[0]||0),guided);
  if(action==='nopoll') {
    await env.HOME_DB.prepare('UPDATE house_collections SET vote_poll_id=NULL,vote_option_index=NULL WHERE id=? AND closed=0')
      .bind(collection.id).run();
    return guided?chooseCollectionBank(env,collection,true):collectionCard(env,{...collection,vote_poll_id:null,vote_option_index:null});
  }
  const pollId=positiveId(args[0]);
  if(!pollId)return;
  const poll=await env.HOME_DB.prepare(`SELECT id,question,options FROM polls WHERE id=? AND chat_id=?
    AND status='open' AND (ends_at IS NULL OR ends_at>unixepoch())`).bind(pollId,collection.chat_id).first<CollectionPoll>();
  if(!poll)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Голосування вже недоступне.');
  const options=JSON.parse(poll.options) as string[];
  if(action==='pollpick') {
    return send(env,env.ADMIN_TELEGRAM_USER_ID,`${poll.question}\nЯку відповідь зараховувати за внесок?`,[
      ...options.map((option,index)=>button(option.slice(0,60),`hc:pollchoice:${collection.id}:${poll.id}:${index}${guided?':setup':''}`)),
      button('Обрати інше голосування',`hc:polls:${collection.id}:0${guided?':setup':''}`),
    ]);
  }
  const index=Number(args[1]);
  if(!/^\d+$/.test(args[1]||'')||!Number.isInteger(index)||index<0||index>=options.length)return;
  const changed=await env.HOME_DB.prepare(`UPDATE house_collections SET vote_poll_id=?,vote_option_index=?
    WHERE id=? AND closed=0 AND EXISTS (SELECT 1 FROM polls p WHERE p.id=? AND p.chat_id=house_collections.chat_id
      AND p.status='open' AND (p.ends_at IS NULL OR p.ends_at>unixepoch()))
    AND NOT EXISTS (SELECT 1 FROM house_collections other WHERE other.vote_poll_id=? AND other.id<>?)`)
    .bind(poll.id,index,collection.id,poll.id,poll.id,collection.id).run();
  if(!changed.meta.changes)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Голосування вже прив’язано до іншого збору або завершено.');
  await syncCollectionVotes(env,collection.id).catch(()=>console.error('Contribution vote sync deferred',collection.id));
  const saved=await findCollection(env,collection.id);
  if(saved)return guided?chooseCollectionBank(env,saved,true):collectionCard(env,saved);
}

async function premiseCollections(env: Env, premiseId: number, action: 'unit'|'history', page: number) {
  const premise=await env.HOME_DB.prepare(`SELECT ${premiseContributionLabel} AS name,chat_id FROM premises WHERE id=?`)
    .bind(premiseId).first<{name:string;chat_id:number}>();
  if(!premise||!isConnected(await getGroup(env,premise.chat_id)))return;

  const history=action==='history';
  const query=history
    ? `SELECT c.id,c.title,t.amount,c.closed FROM collection_totals t JOIN house_collections c ON c.id=t.collection_id
       WHERE c.chat_id=? AND t.premise_id=? ORDER BY c.closed,c.id DESC LIMIT ? OFFSET ?`
    : `SELECT id,title,NULL AS amount,closed FROM house_collections WHERE chat_id=?
       ORDER BY closed,id DESC LIMIT ? OFFSET ?`;
  const scope=history?[premise.chat_id,premiseId]:[premise.chat_id];
  const {results}=await env.HOME_DB.prepare(query).bind(...scope,PAGE_SIZE+1,page*PAGE_SIZE)
    .all<{id:number;title:string;amount:number|null;closed:number}>();
  const entries=results.slice(0,PAGE_SIZE);
  const label=premise.name;
  if(!history&&page===0&&entries.length===1) {
    await askCollectionInput(env,'apartment_amount',entries[0].id,
      `${label} · ${entries[0].title}\nНапишіть суму внеску в гривнях.`,premiseId);
    return;
  }
  const buttons=history?[]:entries.map(entry=>button(entry.title+(entry.closed?' · Завершено':''),`hc:apartment:${entry.id}:${premiseId}`));
  if(page>0)buttons.push(button('← Назад',`hc:${action}:${premiseId}:${page-1}`));
  if(results.length>PAGE_SIZE)buttons.push(button('Далі →',`hc:${action}:${premiseId}:${page+1}`));
  const detail=history?entries.map(entry=>`${entry.title} — ${money(entry.amount!)}`).join('\n')
    : entries.length?'Оберіть збір.':'Зборів ще немає.';
  await send(env,env.ADMIN_TELEGRAM_USER_ID,`${label}\n${detail}`,buttons);
}

async function chooseCollectionBank(env: Env, collection: Collection, guided = false) {
  const {results} = await env.HOME_DB.prepare(`SELECT f.id,f.title FROM mono_funds f WHERE f.chat_id=? AND f.active=1
    AND NOT EXISTS (SELECT 1 FROM house_collections c WHERE c.mono_fund_id=f.id AND c.id!=?) ORDER BY f.title`)
    .bind(collection.chat_id,collection.id).all<{id:string;title:string}>();
  if(guided && !results.length)return chooseCollectionInterval(env,collection);
  const buttons = results.map(f=>button(f.title.slice(0,60),`hc:link:${collection.id}:${f.id}${guided?':setup':''}`));
  buttons.push(guided?button(collection.mono_fund_id?'Далі з поточною банкою':'Далі без банки',`hc:publish:${collection.id}`)
    :button('До збору',`hc:view:${collection.id}`));
  await send(env,env.ADMIN_TELEGRAM_USER_ID,results.length?'Яку банку прив’язати до збору?':'Для цього будинку немає підключених банок.',buttons);
}

function askCollectionCardNumber(env: Env, collection: Collection) {
  return askCollectionInput(env,'card',collection.id,'Напишіть 16 цифр картки банки.',0,true);
}

function chooseCollectionInterval(env: Env, collection: Collection) {
  return send(env,env.ADMIN_TELEGRAM_USER_ID,'Як часто піднімати допис у чаті?',[
    ...REPOST_INTERVALS.map(interval=>button(intervalLabel(interval),`hc:interval:${collection.id}:${interval}`)),
    button('До збору',`hc:view:${collection.id}`),
  ]);
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

export async function refreshBankCollectionPosts(env:Env,fundId:string){
  const {results}=await env.HOME_DB.prepare(`SELECT c.* FROM house_collections c JOIN groups g ON g.chat_id=c.chat_id
    WHERE c.mono_fund_id=? AND c.closed=0 AND c.message_id IS NOT NULL
      AND c.publish_lease_until<=unixepoch() AND g.status='approved' AND g.bot_present=1`).bind(fundId).all<Collection>();
  for(const c of results)await refreshCollectionPost(env,c);
}

export async function scheduledCollections(env: Env) {
  const linked=await env.HOME_DB.prepare(`SELECT c.id FROM house_collections c JOIN polls p ON p.id=c.vote_poll_id
    WHERE p.status='open' AND (p.ends_at IS NULL OR p.ends_at>unixepoch())`).all<{id:number}>();
  for(const {id} of linked.results) {
    await syncCollectionVotes(env,id,true).catch(()=>console.error('Contribution vote sync deferred',id));
  }
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
  const pending=await collectionInput(env);
  if(!pending)return false;
  return handleCollectionInput(env,message.from!.id,pending,message.text.trim(),updateId);
}

async function handleCollectionInput(env: Env, uid: number, pending: {raw:string;input:CollectionInput}, value: string, updateId: number) {
  const {raw,input:current}=pending;
  const claimed=await env.HOME_DB.prepare('UPDATE private_chats SET collection_input=NULL WHERE user_id=? AND collection_input=?')
    .bind(uid,raw).run();
  if(!claimed.meta.changes)return true;
  if(current.expires<Math.floor(Date.now()/1000)) {
    await send(env,uid,'Час минув. Відкрийте збір і повторіть дію.');
    return true;
  }
  if(current.step==='title') {
    if(!value||value.length>80||value.includes('\n')) {
      await askCollectionInput(env,'title',current.target_id,'Напишіть назву збору до 80 символів.',0,current.guided);
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
    if(collection)await askCollectionInput(env,'description',collection.id,'Коротко опишіть, на що збираємо.',0,true);
    return true;
  }
  const collection=await findCollection(env,current.target_id);
  if(!collection||(collection.closed&&current.step!=='allocate'&&current.step!=='apartment_amount')) {
    await send(env,uid,'Збір недоступний для внесків.');
    return true;
  }
  if(current.step==='description'||current.step==='requested'||current.step==='card'||current.step==='bank_url') {
    const step=current.step;
    const column={description:'description',requested:'requested_amount',card:'bank_card',bank_url:'bank_url'}[step];
    const card=value.replace(/\s/g,'');
    const updated=step==='description'?(value==='—'?'':value):step==='requested'?amountInKopiykas(value):step==='bank_url'?(value==='—'?null:value):value==='—'?null:card;
    if((step==='description'&&value.length>1000)||(step==='requested'&&updated===null)||
       (step==='card'&&(!collection.mono_fund_id||(updated!==null&&!/^\d{16}$/.test(card))))||
       (step==='bank_url'&&(!collection.mono_fund_id||(updated!==null&&!/^https:\/\/send\.monobank\.ua\/jar\/[a-zA-Z0-9_-]{1,80}$/.test(value))))) {
      await askCollectionInput(env,step,collection.id,{description:'Опис має бути до 1000 символів.',requested:'Напишіть суму в гривнях, наприклад 2400.',card:'Напишіть 16 цифр картки.',bank_url:'Надішліть посилання у форматі https://send.monobank.ua/jar/…'}[step],0,current.guided);
      return true;
    }
    await env.HOME_DB.prepare(`UPDATE house_collections SET ${column}=? WHERE id=? AND closed=0`).bind(updated,collection.id).run();
    const saved=await findCollection(env,collection.id);
    if(!saved)return true;
    if(!current.guided)await collectionCard(env,saved);
    else if(step==='description')await askCollectionInput(env,'requested',saved.id,'Скільки має внести одна квартира? Напишіть суму в гривнях.',0,true);
    else if(step==='requested')await chooseCollectionPoll(env,saved,0,true);
    else if(step==='bank_url')await askCollectionCardNumber(env,saved);
    else await chooseCollectionInterval(env,saved);
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
      SELECT c.id,?,? FROM house_collections c WHERE c.id=? AND (${resident?'c.closed=0':'1'}) AND ${eligibility}
      AND EXISTS (SELECT 1 FROM updates WHERE id=? AND state='processing')
      ON CONFLICT(collection_id,${column}) DO UPDATE SET amount=amount+excluded.amount`)
      .bind(subject,amount,collection.id,subject,updateId),
    env.HOME_DB.prepare("UPDATE updates SET state='done' WHERE id=?").bind(updateId),
  ]);
  if(!results[0].meta.changes) {
    await send(env,uid,'Не вдалося зарахувати внесок.');
    return true;
  }
  await syncCollectionVotes(env,collection.id).catch(()=>console.error('Contribution vote sync deferred',collection.id));
  await sendManualContributionReceipt(env, collection, resident, subject, amount).catch(()=>{});
  if(resident)await collectionCard(env,collection);
  else {
    const premise=await env.HOME_DB.prepare(`SELECT ${premiseContributionLabel} AS name FROM premises WHERE id=?`).bind(subject).first<{name:string}>();
    await send(env,uid,`${premise?.name ?? 'Приміщення'} · ${collection.title} — зараховано ${money(amount)}`,[
      button('Зарахувати іншому приміщенню',`hc:add:${collection.id}`),
    ]);
  }
  return true;
}

async function sendManualContributionReceipt(env: Env, collection: Collection, resident: boolean, subject: number, amount: number) {
  const recipients = resident
    ? env.HOME_DB.prepare('SELECT user_id FROM profiles WHERE id=? AND user_id>0')
    : env.HOME_DB.prepare(`SELECT DISTINCT u.user_id, p.number FROM memberships m JOIN profiles u ON u.id=m.profile_id
      JOIN premises p ON p.id=m.premise_id
      WHERE m.premise_id=? AND m.status='approved' AND u.user_id>0`);
  const {results} = await recipients.bind(subject).all<{user_id:number;number?:string|null}>();
  await Promise.allSettled(results.map(({user_id, number}) => {
    const apartment = number ? ` від квартири <b>${escapeHtml(number)}</b>` : '';
    const text = `На збір «${escapeHtml(collection.title)}» зараховано <b>${money(amount)}</b>${apartment}. Дякуємо за внесок!`;
    return sendHtml(env,user_id,text);
  }));
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

async function sendApartmentReceipt(env: Env, operationId: number) {
  const {results: residents} = await env.HOME_DB.prepare(`SELECT DISTINCT u.user_id,c.title,p.number,o.amount
    FROM mono_operations o JOIN house_collections c ON c.id=o.collection_id
    JOIN premises p ON p.id=o.credited_premise_id AND p.chat_id=c.chat_id
    JOIN memberships m ON m.premise_id=p.id JOIN profiles u ON u.id=m.profile_id
    WHERE o.rowid=? AND m.status='approved' AND u.user_id>0`)
    .bind(operationId).all<{user_id:number;title:string;number:string;amount:number}>();
  for(const resident of residents) {
    const amount = new Intl.NumberFormat('uk-UA', {maximumFractionDigits: 2}).format(resident.amount / 100);
    const text = `Дякуємо за участь у зборі!\nНа збір «${escapeHtml(resident.title)}» зараховано <b>${amount} ₴</b> від квартири <b>${escapeHtml(resident.number)}</b>.`;
    await sendHtml(env,resident.user_id,text).catch(()=>{});
  }
}

async function allocateBankContribution(env: Env, collectionId: number, operationId: number, premiseId: number) {
  const [,credited] = await env.HOME_DB.batch([
    env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,premise_id,amount)
      SELECT collection_id,?,amount FROM mono_operations WHERE rowid=? AND collection_id=? AND credited_premise_id IS NULL AND amount>0
      ON CONFLICT(collection_id,premise_id) DO UPDATE SET amount=amount+excluded.amount`).bind(premiseId,operationId,collectionId),
    env.HOME_DB.prepare(`UPDATE mono_operations SET credited_premise_id=?
      WHERE rowid=? AND collection_id=? AND credited_premise_id IS NULL AND amount>0`).bind(premiseId,operationId,collectionId),
  ]);
  if(credited.meta.changes) {
    await syncCollectionVotes(env,collectionId).catch(()=>console.error('Contribution vote sync deferred',collectionId));
    await sendApartmentReceipt(env,operationId).catch(()=>{});
  }
}

export async function residentCollectionLines(env: Env, uid: number) {
  const {results}=await env.HOME_DB.prepare(`SELECT c.title,t.premise_id,t.amount
    FROM collection_totals t JOIN house_collections c ON c.id=t.collection_id
    JOIN groups g ON g.chat_id=c.chat_id
    WHERE g.status='approved' AND g.bot_present=1
      AND EXISTS (SELECT 1 FROM memberships m JOIN premises p ON p.id=m.premise_id
        JOIN profiles u ON u.id=m.profile_id
        WHERE u.user_id=? AND m.status='approved' AND p.chat_id=c.chat_id
          AND (t.profile_id=m.profile_id OR t.premise_id=p.id))
    ORDER BY c.closed,c.id DESC`).bind(uid).all<{title:string;premise_id:number|null;amount:number}>();
  const lines = new Map<number|null,string[]>();
  for(const row of results) {
    const entries = lines.get(row.premise_id) ?? [];
    entries.push(`${escapeHtml(row.title)} · <b>${money(row.amount)}</b>`);
    lines.set(row.premise_id, entries);
  }
  return lines;
}

export async function recordBankContribution(env: Env, fundId: string, operation: {
  id: string; time: number; amount: number; comment?: string; balance?:number;
}, notification?: {legacy:string;heading:string}, defer?:(task:Promise<unknown>)=>void) {
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
  if(number&&operation.amount>0) {
    const match = `FROM mono_funds f JOIN house_collections c ON ${link}
      JOIN premises p ON p.chat_id=c.chat_id AND p.kind='apartment' AND p.number=?
      WHERE f.id=? AND NOT EXISTS (SELECT 1 FROM mono_operations WHERE fund_id=f.id AND operation_id=?)`;
    const values = [operation.time,operation.amount,number,fundId,operation.id];
    statements.push(env.HOME_DB.prepare(`INSERT INTO collection_totals(collection_id,premise_id,amount)
      SELECT c.id,p.id,? ${match}
      ON CONFLICT(collection_id,premise_id) DO UPDATE SET amount=amount+excluded.amount`)
      .bind(operation.amount,...values));
  }
  // Balance and contribution are committed with the operation, including on retries after a crash.
  if(operation.balance!==undefined)statements.push(env.HOME_DB.prepare(`UPDATE mono_funds SET balance=?,balance_updated_at=?,error=''
    WHERE id=? AND balance_updated_at<=? AND NOT EXISTS
      (SELECT 1 FROM mono_operations WHERE fund_id=? AND operation_id=?)`)
    .bind(operation.balance,operation.time,fundId,operation.time,fundId,operation.id));
  statements.push(env.HOME_DB.prepare(`INSERT INTO mono_operations(fund_id,operation_id,time,amount,collection_id,credited_premise_id,collection_comment)
    SELECT f.id,?,?,?,c.id,p.id,CASE WHEN c.id IS NOT NULL THEN ? END
    FROM mono_funds f LEFT JOIN house_collections c ON ${link}
    LEFT JOIN premises p ON p.chat_id=c.chat_id AND p.kind='apartment' AND p.number=?
    WHERE f.id=? ON CONFLICT(fund_id,operation_id) DO NOTHING`)
    .bind(operation.id,operation.time,operation.amount,comment||null,operation.time,operation.amount,number,fundId));
  const inserted = (await env.HOME_DB.batch(statements)).at(-1);
  if(number && operation.amount>0 && inserted?.meta.changes && inserted.meta.last_row_id) {
    const receiptId=inserted.meta.last_row_id;
    const deliver=async()=>{
      const linked=await env.HOME_DB.prepare('SELECT collection_id FROM mono_operations WHERE rowid=?')
        .bind(receiptId).first<{collection_id:number|null}>();
      if(linked?.collection_id)await syncCollectionVotes(env,linked.collection_id)
        .catch(()=>console.error('Contribution vote sync deferred',linked.collection_id));
      await sendApartmentReceipt(env,receiptId).catch(()=>{});
    };
    if(defer)defer(deliver());else await deliver();
  }
  return Boolean(inserted?.meta.changes);
}
