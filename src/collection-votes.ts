import type { Env } from './env.ts';

// A contribution belongs to a premise, so no Telegram account is impersonated.
export async function syncCollectionVotes(env: Env, collectionId: number, refresh = false) {
  const collection = await env.HOME_DB.prepare('SELECT vote_poll_id FROM house_collections WHERE id=?')
    .bind(collectionId).first<{vote_poll_id:number|null}>();
  if(!collection?.vote_poll_id)return;
  const result = await env.HOME_DB.prepare(`INSERT INTO premise_votes
    (poll_id,premise_id,user_id,option_index,voter_name,voter_role)
    SELECT poll.id,p.id,0,c.vote_option_index,'Зараховано за внеском','contribution'
    FROM house_collections c JOIN polls poll ON poll.id=c.vote_poll_id AND poll.chat_id=c.chat_id
    JOIN groups g ON g.chat_id=c.chat_id
    JOIN collection_totals t ON t.collection_id=c.id AND t.amount>0
    JOIN premises p ON p.id=t.premise_id AND p.chat_id=c.chat_id
    WHERE c.id=? AND poll.status='open' AND (poll.ends_at IS NULL OR poll.ends_at>unixepoch())
      AND g.status='approved' AND g.bot_present=1
      AND c.vote_option_index>=0 AND c.vote_option_index<json_array_length(poll.options)
    ON CONFLICT(poll_id,premise_id) DO NOTHING`).bind(collectionId).run();
  if(result.meta.changes || refresh) {
    const {refreshPoll}=await import('./polls.ts');
    await refreshPoll(env,collection.vote_poll_id);
  }
}
