import { adminPollReport } from './poll-report.ts';
import type { Button, Callback, Env } from './env.ts';
import { getGroup, isConnected } from './groups.ts';
import { answer, send, sendHtml, telegram, TelegramError } from './telegram.ts';
import { escapeHtml, kyivDate } from './presentation.ts';
import { positiveId } from './validation.ts';
import { intervalLabel } from './poll-settings.ts';
import { livePollView, refreshPoll } from './polls.ts';

interface RepostPoll {
  id:number; chat_id:number; message_id:number|null; status:string; question:string; options:string;
  ends_at:number|null; closed_at:number|null; result_message_id:number|null; repost_interval:number; next_repost_at:number|null; published_at:number|null; last_repost_key:string|null;
}
export async function pollControls(env:Env,id:number) {
  const p=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<RepostPoll>();
  if(!p||p.status==='draft')return send(env,env.ADMIN_TELEGRAM_USER_ID,'Голосування не знайдено.');
  const buttons:Button[][]=[[{text:'📊 Звіт',callback_data:`pollctl:results:${id}`}]];
  if(p.status==='open')buttons.push([{text:'⬆️ Підняти зараз',callback_data:`pollctl:raise:${id}`}],[{text:'🏁 Завершити голосування',callback_data:`pollctl:askclose:${id}`}]);
  buttons.push([{text:'← Мої голосування',callback_data:'pollctl:list:0'},{text:'🏠 Головне меню',callback_data:'resident:menu:0'}]);
  return sendHtml(env,env.ADMIN_TELEGRAM_USER_ID,`🗳 <b>Голосування</b>\n\n${escapeHtml(p.question)}\n\nСтатус: ${p.status==='open'?'відкрите':'завершено'}\nАвтопідняття: ${escapeHtml(intervalLabel(p.repost_interval))}\n📅 Строк: ${p.ends_at?kyivDate(p.ends_at)+' (Київ)':'без строку'}\n\nПідняття публікує нове повідомлення зі збереженими голосами й прибирає старе.`,buttons);
}
export async function adminPollList(env:Env,page=0,status='open') {
  status=status==='closed'?'closed':'open';
  const {results}=await env.HOME_DB.prepare("SELECT id,question FROM polls WHERE status=? ORDER BY id DESC LIMIT 9 OFFSET ?").bind(status,page*8).all<{id:number;question:string}>();
  const buttons:Button[][]=results.slice(0,8).map(p=>[{text:`${p.question}`.slice(0,60),callback_data:`pollctl:show:${p.id}`}]);
  buttons.unshift([{text:status==='open'?'✓ Активні':'Активні',callback_data:'pollctl:list:0:open'},{text:status==='closed'?'✓ Завершені':'Завершені',callback_data:'pollctl:list:0:closed'}]);
  const nav:Button[]=[];
  if(page>0)nav.push({text:'← Назад',callback_data:`pollctl:list:${page-1}:${status}`});
  if(results.length>8)nav.push({text:'Далі →',callback_data:`pollctl:list:${page+1}:${status}`});
  if(nav.length)buttons.push(nav);
  buttons.push([{text:'🏠 Головне меню',callback_data:'resident:menu:0'}]);
  return send(env,env.ADMIN_TELEGRAM_USER_ID,results.length?'🗳 Оберіть голосування для перегляду звіту та керування.':status==='closed'?'Завершених голосувань немає.':'Відкритих голосувань немає.',buttons);
}
function currentLink(p:RepostPoll) {
  const chat=String(p.chat_id);
  return chat.startsWith('-100')&&p.message_id?`https://t.me/c/${chat.slice(4)}/${p.message_id}`:null;
}
export async function cleanupPollCopies(env:Env,pollId?:number) {
  const {results}=await env.HOME_DB.prepare(`SELECT c.*,p.message_id AS current_message_id FROM poll_message_cleanup c JOIN polls p ON p.id=c.poll_id
    JOIN groups g ON g.chat_id=p.chat_id WHERE g.status='approved' AND g.bot_present=1 AND c.message_id!=p.message_id
    AND (c.redirected_to IS NULL OR c.redirected_to!=p.message_id) ${pollId?'AND c.poll_id=?':''} LIMIT 20`).bind(...(pollId?[pollId]:[])).all<{poll_id:number;chat_id:number;message_id:number;current_message_id:number}>();
  for(const copy of results){
    try{
      await telegram(env,'deleteMessage',{chat_id:copy.chat_id,message_id:copy.message_id});
      await env.HOME_DB.prepare('DELETE FROM poll_message_cleanup WHERE poll_id=? AND message_id=?').bind(copy.poll_id,copy.message_id).run();
    }catch(error){
      if(error instanceof TelegramError && error.reason==='not_found'){
        await env.HOME_DB.prepare('DELETE FROM poll_message_cleanup WHERE poll_id=? AND message_id=?').bind(copy.poll_id,copy.message_id).run();continue;
      }
      if(!(error instanceof TelegramError)||error.reason!=='cannot_delete'){console.error('Poll copy cleanup deferred',{pollId:copy.poll_id,messageId:copy.message_id});continue;}
      try{
        const latest=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(copy.poll_id).first<RepostPoll>();
        if(latest?.status==='closed' && latest.result_message_id){
          const finalView=await livePollView(env,latest);
          await telegram(env,'editMessageText',{chat_id:copy.chat_id,message_id:copy.message_id,text:finalView.text,parse_mode:'HTML',reply_markup:{inline_keyboard:[]}});
          await env.HOME_DB.prepare('UPDATE poll_message_cleanup SET redirected_to=? WHERE poll_id=? AND message_id=?').bind(latest.message_id,copy.poll_id,copy.message_id).run();
          continue;
        }
        const link=currentLink({chat_id:copy.chat_id,message_id:copy.current_message_id} as RepostPoll);
        await telegram(env,'editMessageText',{chat_id:copy.chat_id,message_id:copy.message_id,
          text:`⬆️ Голосування перенесено.\n${link?'Відкрийте актуальне повідомлення кнопкою нижче.':'Актуальне голосування розташоване нижче в чаті.'}`,
          reply_markup:{inline_keyboard:link?[[{text:'Перейти до голосування',url:link}]]:[]}});
        await env.HOME_DB.prepare('UPDATE poll_message_cleanup SET redirected_to=? WHERE poll_id=? AND message_id=?').bind(copy.current_message_id,copy.poll_id,copy.message_id).run();
      }catch{console.error('Poll redirect deferred',{pollId:copy.poll_id,messageId:copy.message_id});}
    }
  }
}
export async function raisePoll(env:Env,id:number,requestKey:string,scheduledDue?:number):Promise<'raised'|'already'|'unavailable'|'busy'> {
  const before=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<RepostPoll>();
  if(!before||before.status!=='open'||(before.ends_at!==null&&before.ends_at<=Math.floor(Date.now()/1000))||!before.message_id||!isConnected(await getGroup(env,before.chat_id)))return 'unavailable';
  const completed=await env.HOME_DB.prepare('SELECT request_key FROM poll_repost_runs WHERE request_key=? AND poll_id=?').bind(requestKey,id).first();
  if(completed||before.last_repost_key===requestKey){await refreshPoll(env,id);await cleanupPollCopies(env,id);return 'already';}
  const lease=crypto.randomUUID();
  const claim=await env.HOME_DB.prepare(`UPDATE polls SET repost_lease=?,repost_lease_until=unixepoch()+180 WHERE id=? AND status='open' AND (ends_at IS NULL OR ends_at>unixepoch())
    AND (repost_lease_until IS NULL OR repost_lease_until<unixepoch()) AND (last_repost_key IS NULL OR last_repost_key!=?)
    ${scheduledDue!==undefined?'AND next_repost_at=? AND next_repost_at<=unixepoch() AND repost_interval>0':''}`)
    .bind(...(scheduledDue!==undefined?[lease,id,requestKey,scheduledDue]:[lease,id,requestKey])).run();
  if(!claim.meta.changes)return 'busy';
  try{
    const p=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=? AND repost_lease=?').bind(id,lease).first<RepostPoll>();
    if(!p||p.status!=='open'||(p.ends_at!==null&&p.ends_at<=Math.floor(Date.now()/1000))||!p.message_id)return 'unavailable';
    const view=await livePollView(env,p);
    // Publish first. Votes belong to the poll, never to its Telegram message.
    const fresh=await sendHtml(env,p.chat_id,view.text,view.buttons);
    const result=await env.HOME_DB.batch([
      env.HOME_DB.prepare(`UPDATE polls SET message_id=?,published_at=unixepoch(),next_repost_at=CASE WHEN repost_interval>0 THEN unixepoch()+repost_interval ELSE NULL END,
        last_repost_key=? WHERE id=? AND status='open' AND (ends_at IS NULL OR ends_at>unixepoch()) AND repost_lease=? AND message_id=?`).bind(fresh.message_id,requestKey,id,lease,p.message_id),
      env.HOME_DB.prepare('INSERT INTO poll_message_cleanup(poll_id,chat_id,message_id) SELECT id,chat_id,? FROM polls WHERE id=? AND message_id=? AND repost_lease=? ON CONFLICT(poll_id,message_id) DO NOTHING')
        .bind(p.message_id,id,fresh.message_id,lease),
      env.HOME_DB.prepare('INSERT INTO poll_repost_runs(request_key,poll_id,new_message_id) SELECT ?,id,message_id FROM polls WHERE id=? AND message_id=? AND repost_lease=? ON CONFLICT(request_key) DO NOTHING').bind(requestKey,id,fresh.message_id,lease),
    ]);
    if(!result[0].meta.changes){
      // A close may have raced with the Telegram send. Clean up the unused copy.
      await env.HOME_DB.prepare('INSERT INTO poll_message_cleanup(poll_id,chat_id,message_id) VALUES (?,?,?) ON CONFLICT(poll_id,message_id) DO NOTHING').bind(id,p.chat_id,fresh.message_id).run();
      await cleanupPollCopies(env,id);return 'unavailable';
    }
    await refreshPoll(env,id);
    await cleanupPollCopies(env,id);
    return 'raised';
  }catch(error){
    // Keep the original message if sending failed; retry scheduled failures in 5 minutes.
    await env.HOME_DB.prepare("UPDATE polls SET next_repost_at=CASE WHEN status='open' AND repost_interval>0 AND next_repost_at<=unixepoch() THEN unixepoch()+300 ELSE next_repost_at END WHERE id=? AND repost_lease=?").bind(id,lease).run();
    throw error;
  }finally{
    await env.HOME_DB.prepare('UPDATE polls SET repost_lease=NULL,repost_lease_until=NULL WHERE id=? AND repost_lease=?').bind(id,lease).run();
  }
}
export async function scheduledReposts(env:Env) {
  const {finishDuePolls}=await import('./poll-finishing.ts');
  if(await finishDuePolls(env)){await cleanupPollCopies(env);return;}
  const {results}=await env.HOME_DB.prepare(`SELECT p.id,p.next_repost_at FROM polls p JOIN groups g ON g.chat_id=p.chat_id
    WHERE p.status='open' AND (p.ends_at IS NULL OR p.ends_at>unixepoch()) AND p.repost_interval>0 AND p.next_repost_at<=unixepoch() AND g.status='approved' AND g.bot_present=1 ORDER BY p.next_repost_at LIMIT 1`)
    .all<{id:number;next_repost_at:number}>();
  for(const p of results){try{await raisePoll(env,p.id,`scheduled:${p.id}:${p.next_repost_at}`,p.next_repost_at);}catch{console.error('Scheduled poll repost failed',{pollId:p.id});}}
  const countdown=await env.HOME_DB.prepare("SELECT p.id FROM polls p JOIN groups g ON g.chat_id=p.chat_id WHERE p.status='open' AND p.ends_at>unixepoch() AND p.last_countdown_at<unixepoch()-240 AND g.status='approved' AND g.bot_present=1 ORDER BY p.last_countdown_at,p.id LIMIT 1").first<{id:number}>();
  if(countdown){try{await refreshPoll(env,countdown.id);await env.HOME_DB.prepare('UPDATE polls SET last_countdown_at=unixepoch() WHERE id=?').bind(countdown.id).run();}catch{console.error('Poll countdown refresh deferred',{pollId:countdown.id});}}
  await cleanupPollCopies(env);
}
export async function pollControlCallback(env:Env,q:Callback,updateId:number):Promise<boolean> {
  if(!q.data?.startsWith('pollctl:'))return false;
  if(String(q.from.id)!==env.ADMIN_TELEGRAM_USER_ID||q.message?.chat.type!=='private'||q.message.chat.id!==q.from.id){await answer(env,q.id,'Лише для адміністратора в особистому чаті.');return true;}
  const [,action,raw,confirmationToken]=q.data.split(':');
  if(action==='list'){
    const page=Number(raw);if(!Number.isSafeInteger(page)||page<0||page>100000){await answer(env,q.id,'Недоступна сторінка.');return true;}
    await answer(env,q.id,'Керування голосуваннями.');await adminPollList(env,page,confirmationToken);return true;
  }
  const id=positiveId(raw);if(!id){await answer(env,q.id,'Невідоме голосування.');return true;}
  if(action==='raise'){
    await answer(env,q.id,'Піднімаю голосування.');
    const result=await raisePoll(env,id,`manual:${updateId}`);
    await send(env,q.from.id,result==='raised'||result==='already'?'✅ Голосування піднято. Усі голоси збережено.':result==='busy'?'Голосування вже піднімається. Спробуйте за хвилину.':'Це голосування вже закрито або групу від’єднано.');
    await pollControls(env,id);return true;
  }
  if(action==='askdelete'){
    const p=await env.HOME_DB.prepare("SELECT question FROM polls WHERE id=? AND status='closed'").bind(id).first<{question:string}>();
    if(!p){await answer(env,q.id,'Видалити можна лише завершене голосування.');return true;}
    const token=crypto.randomUUID().replace(/-/g,'').slice(0,16);
    await env.HOME_DB.prepare(`INSERT INTO poll_delete_confirmations VALUES (?,?,?,unixepoch()+300) ON CONFLICT(user_id,poll_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`).bind(token,q.from.id,id).run();
    await answer(env,q.id,'Перевірте питання.');
    await sendHtml(env,q.from.id,`🗑 <b>Видалити голосування?</b>\n\n${escapeHtml(p.question)}\n\nПитання, голоси та статистику буде видалено з бази назавжди. Дані мешканців залишаться. Повідомлення в групі залишаться.`,[[{text:'Залишити',callback_data:`pollctl:canceldelete:${id}`}],[{text:'Так, видалити назавжди',callback_data:`pollctl:delete:${id}:${token}`}]]);return true;
  }
  if(action==='canceldelete'){
    await env.HOME_DB.prepare('DELETE FROM poll_delete_confirmations WHERE user_id=? AND poll_id=?').bind(q.from.id,id).run();await answer(env,q.id,'Голосування збережено.');await adminPollReport(env,id);return true;
  }
  if(action==='delete'){
    const guard=`EXISTS (SELECT 1 FROM poll_delete_confirmations c JOIN polls p ON p.id=c.poll_id WHERE c.token=? AND c.user_id=? AND c.poll_id=? AND c.expires_at>unixepoch() AND p.status='closed' AND (p.repost_lease_until IS NULL OR p.repost_lease_until<unixepoch()))`;
    const args=[confirmationToken||'',q.from.id,id];
    const tables=['premise_votes','votes','vote_intents','poll_repost_runs','poll_message_cleanup','poll_close_confirmations'];
    const results=await env.HOME_DB.batch([...tables.map(table=>env.HOME_DB.prepare(`DELETE FROM ${table} WHERE poll_id=? AND ${guard}`).bind(id,...args)),env.HOME_DB.prepare(`DELETE FROM polls WHERE id=? AND ${guard}`).bind(id,...args)]);
    const deleted=!!results.at(-1)?.meta.changes;
    await answer(env,q.id,deleted?'Голосування видалено.':'Підтвердження застаріло або голосування обробляється. Відкрийте його ще раз.');
    if(deleted)await adminPollList(env,0,'closed');return true;
  }
  const {pollResults}=await import('./polls.ts');
  if(action==='results'){await answer(env,q.id,'Результати.');await adminPollReport(env,id);return true;}
  if(action==='askclose'){
    const poll=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<RepostPoll>();
    if(!poll||poll.status!=='open'){await answer(env,q.id,'Це голосування вже завершено.');await pollControls(env,id);return true;}
    const token=crypto.randomUUID().replace(/-/g,'').slice(0,16);
    await env.HOME_DB.prepare(`INSERT INTO poll_close_confirmations(token,user_id,poll_id,expires_at) VALUES (?,?,?,unixepoch()+300)
      ON CONFLICT(user_id,poll_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`).bind(token,q.from.id,id).run();
    const group=await getGroup(env,poll.chat_id);
    await answer(env,q.id,'Перевірте питання та підтвердіть завершення.');
    await sendHtml(env,q.from.id,`🏁 <b>Завершити це голосування?</b>\n\n<b>${escapeHtml(poll.question)}</b>\n${escapeHtml(group?.title||'')}\n\nНові голоси більше не прийматимуться. Бот опублікує підсумок, прибере картку з кнопками та зупинить автопідняття.\n\nЦе завершення не можна скасувати.`,[[{text:'🏁 Так, завершити це голосування',callback_data:`pollctl:close:${id}:${token}`}],[{text:'Ні, залишити відкритим',callback_data:`pollctl:cancelclose:${id}`}]]);return true;
  }
  if(action==='cancelclose'){
    await env.HOME_DB.prepare('DELETE FROM poll_close_confirmations WHERE user_id=? AND poll_id=?').bind(q.from.id,id).run();
    await answer(env,q.id,'Голосування залишається відкритим.');await pollControls(env,id);return true;
  }
  if(action==='close'){
    const confirmation=confirmationToken?await env.HOME_DB.prepare('SELECT token FROM poll_close_confirmations WHERE token=? AND user_id=? AND poll_id=? AND expires_at>unixepoch()').bind(confirmationToken,q.from.id,id).first():null;
    if(!confirmation){await answer(env,q.id,'Це підтвердження застаріло. Натисніть «Завершити голосування» ще раз і перевірте питання.');return true;}
    await answer(env,q.id,'Завершую голосування.');await pollResults(env,id,true);
    await env.HOME_DB.prepare('DELETE FROM poll_close_confirmations WHERE token=? AND user_id=?').bind(confirmationToken,q.from.id).run();
    await pollControls(env,id);return true;
  }
  if(action==='show'){await answer(env,q.id,'Налаштування голосування.');await pollControls(env,id);return true;}
  await answer(env,q.id,'Недоступна дія.');return true;
}
