import type { Env } from './env.ts';

export async function phoneInUse(env:Env,phone:string,uid:number){
  return !!await env.HOME_DB.prepare('SELECT id FROM profiles WHERE phone=? AND user_id IS NOT NULL AND user_id!=? LIMIT 1').bind(phone,uid).first();
}

// Link the existing person in place, retaining profile and membership IDs.
export async function claimImportedResidents(env:Env,uid:number,chatId:number,phone:string,username:string){
  const profile=await env.HOME_DB.prepare(`SELECT u.id FROM profiles u JOIN memberships m ON m.profile_id=u.id
    JOIN premises p ON p.id=m.premise_id WHERE u.phone=? AND u.user_id IS NULL
    AND p.chat_id=? AND m.status='approved' LIMIT 1`).bind(phone,chatId).first<{id:number}>();
  if(!profile)return false;
  const results=await env.HOME_DB.batch([
    env.HOME_DB.prepare(`UPDATE profiles SET user_id=?,telegram_username=?,updated_at=unixepoch()
      WHERE id=? AND user_id IS NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=?)`)
      .bind(uid,username,profile.id,uid),
    env.HOME_DB.prepare(`UPDATE memberships SET user_id=? WHERE profile_id=? AND user_id IS NULL
      AND EXISTS (SELECT 1 FROM profiles WHERE id=? AND user_id=?)`).bind(uid,profile.id,profile.id,uid),
  ]);
  return Number(results[0].meta.changes)>0;
}
