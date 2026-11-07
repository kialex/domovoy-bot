import { ownMemberships, premiseLabel } from './premises.ts';
import { escapeHtml } from './presentation.ts';
import { pollCard } from './presentation.ts';
import { connectedGroups, getGroup, isConnected } from './groups.ts';
import type { Callback, Env } from './env.ts';
import { answer, botStartUrl, registrationUrl, send, sendHtml, telegram } from './telegram.ts';
import { parsePoll, positiveId } from './validation.ts';

interface Poll { id: number; question: string; options: string; chat_id: number; message_id: number | null; status: string }
export async function createPoll(env: Env, input: string | { question: string; options: string[] }, updateId: number, chatId?: number, groupVersion?: number) {
  const parsed = typeof input === 'string' ? parsePoll(input) : input;
  if (!parsed) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Формат: /poll Питання | Варіант 1 | Варіант 2\nВід 2 до 8 різних варіантів (до 60 символів), питання — до 300 символів.');
  if (!chatId) {
    const groups = await connectedGroups(env);
    if (groups.length !== 1) {
      await send(env, env.ADMIN_TELEGRAM_USER_ID, 'Оберіть групу через покрокове створення голосування.', [[{ text: 'Створити голосування', callback_data: 'admin:newpoll' }]]);
      return false;
    }
    chatId = groups[0].chat_id;
  }
  const group = await getGroup(env, chatId);
  if (!isConnected(group) || (groupVersion !== undefined && group.version !== groupVersion)) {
    await send(env, env.ADMIN_TELEGRAM_USER_ID, 'Підключення цієї групи змінилося. Створіть нову чернетку й оберіть групу знову.'); return false;
  }
  await env.HOME_DB.prepare('INSERT INTO polls(question,options,chat_id,created_by,source_update_id) VALUES (?,?,?,?,?) ON CONFLICT(source_update_id) DO NOTHING')
    .bind(parsed.question, JSON.stringify(parsed.options), chatId, env.ADMIN_TELEGRAM_USER_ID, updateId).run();
  const poll = await env.HOME_DB.prepare('SELECT * FROM polls WHERE source_update_id=?').bind(updateId).first<Poll>();
  if (!poll) throw new Error('Poll creation failed');
  if (poll.message_id) return true;
  if (poll.chat_id !== chatId || poll.status !== 'draft') return false;
  const view = await livePollView(env, poll);
  const message = await sendHtml(env, poll.chat_id, view.text, view.buttons);
  await env.HOME_DB.prepare("UPDATE polls SET message_id=?, status='open' WHERE id=? AND status='draft'").bind(message.message_id, poll.id).run();
  await send(env, env.ADMIN_TELEGRAM_USER_ID, `Голосування №${poll.id} опубліковано в групі «${group.title}».\n/results ${poll.id} — результати\n/close ${poll.id} — завершити`);
  return true;
}
async function livePollView(env: Env, poll: Poll) {
  const options = JSON.parse(poll.options) as string[];
  const { results } = await env.HOME_DB.prepare('SELECT option_index,COUNT(*) AS count FROM premise_votes WHERE poll_id=? GROUP BY option_index').bind(poll.id).all<{ option_index: number; count: number }>();
  const counts = new Map(results.map(r => [r.option_index, r.count]));
  return {
    text: pollCard(poll.id, poll.question, options, counts, false),
    buttons: [
      ...options.map((text, index) => [{ text: `${text} · ${counts.get(index) || 0}`, callback_data: `vote:${poll.id}:${index}` }]),
    ],
  };
}
interface Intent { token:string; user_id:number; poll_id:number; option_index:number; expires_at:number; bulk_ids:string|null }
export async function refreshPoll(env:Env,id:number) {
  const poll=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<Poll>();
  if(!poll || poll.status!=='open' || !poll.message_id || !isConnected(await getGroup(env,poll.chat_id)))return;
  const view=await livePollView(env,poll);
  await telegram(env,'editMessageText',{chat_id:poll.chat_id,message_id:poll.message_id,text:view.text,parse_mode:'HTML',reply_markup:{inline_keyboard:view.buttons}});
}
function castStatement(env:Env,poll:Poll,uid:number,premiseId:number,option:number) {
  return env.HOME_DB.prepare(`INSERT INTO premise_votes(poll_id,premise_id,user_id,option_index)
    SELECT p.id,u.id,m.user_id,? FROM polls p JOIN premises u ON u.chat_id=p.chat_id
    JOIN memberships m ON m.premise_id=u.id JOIN profiles profile ON profile.user_id=m.user_id JOIN groups g ON g.chat_id=p.chat_id
    WHERE p.id=? AND p.status='open' AND u.id=? AND m.user_id=? AND m.status='approved'
    AND profile.phone GLOB '+380[1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND g.status='approved' AND g.bot_present=1
    ON CONFLICT(poll_id,premise_id) DO UPDATE SET option_index=excluded.option_index,updated_at=unixepoch()
    WHERE premise_votes.user_id=excluded.user_id`).bind(option,poll.id,premiseId,uid);
}
async function validIntent(env:Env,uid:number,token:string) {
  const intent=await env.HOME_DB.prepare('SELECT * FROM vote_intents WHERE token=? AND user_id=? AND expires_at>unixepoch()').bind(token,uid).first<Intent>();
  if(!intent)return null;
  const poll=await env.HOME_DB.prepare("SELECT * FROM polls WHERE id=? AND status='open'").bind(intent.poll_id).first<Poll>();
  if(!poll||!isConnected(await getGroup(env,poll.chat_id)))return null;
  const options=JSON.parse(poll.options) as string[];
  if(!Number.isInteger(intent.option_index)||!options[intent.option_index])return null;
  return {intent,poll,options};
}
export async function openVoteIntent(env:Env,uid:number,token:string,page=0) {
  const context=await validIntent(env,uid,token);
  if(!context)return send(env,uid,'Цей вибір уже недоступний або минуло 15 хвилин. Поверніться до голосування у групі та натисніть відповідь знову.');
  const {intent,poll,options}=context;
  const units=await ownMemberships(env,uid,poll.chat_id,true);
  if(!units.length)return send(env,uid,'Немає підтверджених приміщень у цій групі. Додайте приміщення та дочекайтеся підтвердження.');
  const votes=(await env.HOME_DB.prepare('SELECT premise_id,user_id,option_index FROM premise_votes WHERE poll_id=?').bind(poll.id).all<{premise_id:number;user_id:number;option_index:number}>()).results;
  const byId=new Map(votes.map(v=>[v.premise_id,v]));
  const buttons=units.slice(page*8,page*8+8).map(p=>{
    const old=byId.get(p.id);
    return [{text:`${old?(old.user_id===uid?'✅':'🔒'):'🏠'} ${premiseLabel(p)}`,callback_data:`cast:${token}:${p.id}`}];
  });
  const navigation=[];
  if(page>0)navigation.push({text:'← Назад',callback_data:`vp:${token}:${page-1}`});
  if(units.length>(page+1)*8)navigation.push({text:'Далі →',callback_data:`vp:${token}:${page+1}`});
  if(navigation.length)buttons.push(navigation);
  if(units.length>1)buttons.push([{text:'Обрати цю відповідь для всіх моїх приміщень',callback_data:`va:ask:${token}`}]);
  return sendHtml(env,uid,`🗳 <b>Від якого приміщення голосуємо?</b>\n\n${escapeHtml(poll.question)}\nВаш вибір: <b>${escapeHtml(options[intent.option_index])}</b>\n\nОберіть приміщення нижче.\n✅ — ваш голос уже подано; його можна змінити.\n🔒 — голос подав інший мешканець приміщення.`,buttons);
}
export async function vote(env: Env, query: Callback) {
  const [,rawId,rawOption]=(query.data||'').split(':');
  const pollId=positiveId(rawId);const option=/^\d+$/.test(rawOption||'')?Number(rawOption):-1;
  const poll=pollId?await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(pollId).first<Poll>():null;
  if(!poll||poll.status!=='open'||!query.message||query.message.chat.id!==poll.chat_id||query.message.message_id!==poll.message_id||!isConnected(await getGroup(env,poll.chat_id)))return answer(env,query.id,'Голосування недоступне або завершене.');
  const options=JSON.parse(poll.options) as string[];
  if(!Number.isInteger(option)||option<0||option>=options.length)return answer(env,query.id,'Некоректна відповідь.');
  const units=await ownMemberships(env,query.from.id,poll.chat_id,true);
  if(!units.length)return answer(env,query.id,'Для голосування зареєструйте приміщення та дочекайтеся підтвердження.',await registrationUrl(env,poll.id));
  if(units.length===1){
    const result=await castStatement(env,poll,query.from.id,units[0].id,option).run();
    if(result.meta.changes)await refreshPoll(env,poll.id);
    return answer(env,query.id,result.meta.changes?`Голос прийнято: ${options[option]}`:'Голос уже подав інший мешканець цього приміщення або доступ змінився.');
  }
  const token=crypto.randomUUID().replace(/-/g,'').slice(0,16);
  await env.HOME_DB.prepare(`INSERT INTO vote_intents(token,user_id,poll_id,option_index,expires_at) VALUES (?,?,?,?,unixepoch()+900)
    ON CONFLICT(user_id,poll_id) DO UPDATE SET token=excluded.token,option_index=excluded.option_index,expires_at=excluded.expires_at,bulk_ids=NULL`).bind(token,query.from.id,poll.id,option).run();
  return answer(env,query.id,'Оберіть приміщення в особистому чаті.',await botStartUrl(env,`vote_${token}`));
}
export async function privateVoteCallback(env:Env,q:Callback):Promise<boolean> {
  const [action,value,extra]= (q.data||'').split(':');
  if(!['cast','va','vp'].includes(action))return false;
  if(q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id){await answer(env,q.id,'Оберіть приміщення в особистому чаті.');return true;}
  const token=action==='va'?extra:value;
  const context=await validIntent(env,q.from.id,token||'');
  if(!context){await answer(env,q.id,'Вибір застарів або голосування завершене. Натисніть відповідь у групі знову.');return true;}
  const {intent,poll,options}=context;
  if(action==='vp'){
    const page=Number(extra);if(!Number.isSafeInteger(page)||page<0||page>100000){await answer(env,q.id,'Недоступна сторінка.');return true;}
    await answer(env,q.id,'Оберіть приміщення.');await openVoteIntent(env,q.from.id,token,page);return true;
  }
  const units=await ownMemberships(env,q.from.id,poll.chat_id,true);
  if(action==='va'&&value==='ask'){
    if(!units.length){await answer(env,q.id,'Немає доступних приміщень.');return true;}
    await env.HOME_DB.prepare('UPDATE vote_intents SET bulk_ids=? WHERE token=? AND user_id=?').bind(JSON.stringify(units.map(p=>p.id)),token,q.from.id).run();
    await answer(env,q.id,'Підтвердіть спільний вибір.');
    await sendHtml(env,q.from.id,`Підтвердити відповідь <b>${escapeHtml(options[intent.option_index])}</b> для всіх ваших приміщень у цьому голосуванні?\n\n${escapeHtml(units.map(p=>premiseLabel(p)).join('\n'))}\n\nВаші попередні відповіді буде змінено. Голоси інших мешканців не перезаписуються.`,[[{text:'✅ Підтвердити для всіх',callback_data:`va:confirm:${token}`}],[{text:'Обрати окреме приміщення',callback_data:`vp:${token}:0`}]]);return true;
  }
  const bulkIds = intent.bulk_ids ? JSON.parse(intent.bulk_ids) as number[] : [];
  const selected=action==='cast'?units.filter(p=>p.id===positiveId(extra)):action==='va'&&value==='confirm'?units.filter(p=>bulkIds.includes(p.id)):[];
  if(!selected.length){await answer(env,q.id,'Немає права голосувати від цих приміщень.');return true;}
  const results=await env.HOME_DB.batch(selected.map(p=>castStatement(env,poll,q.from.id,p.id,intent.option_index)));
  if (action==='va') await env.HOME_DB.prepare('UPDATE vote_intents SET bulk_ids=NULL WHERE token=? AND user_id=?').bind(token,q.from.id).run();
  const changed=results.reduce((sum,r)=>sum+(r.meta.changes?1:0),0);
  if(changed)await refreshPoll(env,poll.id);
  await answer(env,q.id,changed?`Голос прийнято від приміщень: ${changed}.`:'Голос уже подав інший мешканець або доступ змінився.');
  await openVoteIntent(env,q.from.id,token);return true;
}
export async function pollResults(env: Env, id: number, close: boolean) {
  const poll = await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<Poll>();
  if (!poll || poll.status === 'draft') return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Голосування не знайдено або ще не опубліковано.');
  // Close first so subsequent votes cannot change the final tally.
  if (close) await env.HOME_DB.prepare("UPDATE polls SET status='closed' WHERE id=?").bind(id).run();
  const { results } = await env.HOME_DB.prepare('SELECT option_index, COUNT(*) AS count FROM premise_votes WHERE poll_id=? GROUP BY option_index').bind(id).all<{ option_index: number; count: number }>();
  const counts = new Map(results.map(r => [r.option_index, r.count]));
  const options = JSON.parse(poll.options) as string[];
  const text = pollCard(id, poll.question, options, counts, close || poll.status === 'closed');
  if (close && poll.message_id && isConnected(await getGroup(env, poll.chat_id))) {
    await telegram(env, 'editMessageText', { chat_id: poll.chat_id, message_id: poll.message_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  }
  return sendHtml(env, env.ADMIN_TELEGRAM_USER_ID, text);
}
