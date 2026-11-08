import { sendPollView } from './poll-view.ts';
import type { Env } from './env.ts';
import { getGroup, isConnected } from './groups.ts';
import { livePollView, refreshPoll } from './polls.ts';
import { cleanupPollCopies } from './poll-reposting.ts';

export async function finishPoll(env:Env,id:number):Promise<boolean> {
  await env.HOME_DB.prepare(`UPDATE polls SET status='closed',next_repost_at=NULL,
    closed_at=COALESCE(closed_at,CASE WHEN ends_at IS NOT NULL AND ends_at<=unixepoch() THEN ends_at ELSE unixepoch() END)
    WHERE id=? AND status IN ('open','closed')`).bind(id).run();
  const p=await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<{
    id:number;chat_id:number;message_id:number|null;result_message_id:number|null;status:string;question:string;options:string;closed_at:number;ends_at:number|null;
  }>();
  if(!p||p.status!=='closed'||!isConnected(await getGroup(env,p.chat_id)))return false;
  if(p.result_message_id){await cleanupPollCopies(env,id);return true;}
  const lease=crypto.randomUUID();
  const claim=await env.HOME_DB.prepare(`UPDATE polls SET repost_lease=?,repost_lease_until=unixepoch()+180
    WHERE id=? AND status='closed' AND result_message_id IS NULL AND (repost_lease_until IS NULL OR repost_lease_until<unixepoch())`).bind(lease,id).run();
  if(!claim.meta.changes)return false;
  try{
    const view=await livePollView(env,p);
    // Publish a separate final outcome before deleting the voting card.
    const result=await sendPollView(env,p.chat_id,view);
    const committed=await env.HOME_DB.batch([
      env.HOME_DB.prepare("UPDATE polls SET result_message_id=?,message_id=?,published_at=unixepoch() WHERE id=? AND status='closed' AND result_message_id IS NULL AND repost_lease=?").bind(result.message_id,result.message_id,id,lease),
      env.HOME_DB.prepare(`INSERT INTO poll_message_cleanup(poll_id,chat_id,message_id) SELECT id,chat_id,? FROM polls
        WHERE id=? AND result_message_id=? AND repost_lease=? AND ? IS NOT NULL ON CONFLICT(poll_id,message_id) DO NOTHING`).bind(p.message_id,id,result.message_id,lease,p.message_id),
    ]);
    if(!committed[0].meta.changes){
      await env.HOME_DB.prepare('INSERT INTO poll_message_cleanup(poll_id,chat_id,message_id) VALUES (?,?,?) ON CONFLICT(poll_id,message_id) DO NOTHING').bind(id,p.chat_id,result.message_id).run();
    }
    await cleanupPollCopies(env,id);
    return !!committed[0].meta.changes;
  }catch(error){
    // Lock votes immediately even if Telegram is down; the scheduler retries publication.
    try{await refreshPoll(env,id);}catch{console.error('Final poll card refresh deferred',{pollId:id});}
    throw error;
  }finally{
    await env.HOME_DB.prepare('UPDATE polls SET repost_lease=NULL,repost_lease_until=NULL WHERE id=? AND repost_lease=?').bind(id,lease).run();
  }
}
export async function finishDuePolls(env:Env):Promise<boolean> {
  await env.HOME_DB.prepare("UPDATE polls SET status='closed',closed_at=COALESCE(closed_at,ends_at),next_repost_at=NULL WHERE status='open' AND ends_at IS NOT NULL AND ends_at<=unixepoch()").run();
  const {results}=await env.HOME_DB.prepare(`SELECT p.id FROM polls p JOIN groups g ON g.chat_id=p.chat_id
    WHERE p.status='closed' AND p.closed_at IS NOT NULL AND p.result_message_id IS NULL AND g.status='approved' AND g.bot_present=1
    ORDER BY p.closed_at LIMIT 1`).all<{id:number}>();
  for(const p of results){try{await finishPoll(env,p.id);}catch{console.error('Final poll result publication deferred',{pollId:p.id});}}
  return results.length>0;
}
