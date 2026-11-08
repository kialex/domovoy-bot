import type { Env } from './env.ts';

export async function phoneInUse(env:Env,phone:string,uid:number){
  return !!await env.HOME_DB.prepare('SELECT user_id FROM profiles WHERE phone=? AND user_id!=? LIMIT 1').bind(phone,uid).first();
}

// D1 executes this batch in one transaction: a second account cannot claim the
// same contact between checking the profile and creating its memberships.
export async function claimImportedResidents(env:Env,uid:number,chatId:number,phone:string,username:string){
  const contact=await env.HOME_DB.prepare(`SELECT r.name FROM imported_residents r JOIN premises p ON p.id=r.premise_id
    WHERE r.phone=? AND r.claimed_by IS NULL AND p.chat_id=? ORDER BY r.id LIMIT 1`).bind(phone,chatId).first<{name:string}>();
  if(!contact)return false;
  const guard='NOT EXISTS (SELECT 1 FROM profiles WHERE phone=? AND user_id!=?)';
  const results=await env.HOME_DB.batch([
    env.HOME_DB.prepare(`INSERT INTO profiles(user_id,name,phone,telegram_username) SELECT ?,?,?,? WHERE ${guard}
      ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,telegram_username=excluded.telegram_username,updated_at=unixepoch()`)
      .bind(uid,contact.name,phone,username,phone,uid),
    env.HOME_DB.prepare(`INSERT INTO memberships(user_id,premise_id,role,status,application_token,details,reviewed_by,reviewed_at)
      SELECT ?,r.premise_id,r.role,'approved',lower(hex(randomblob(16))),json_object('name',r.name,'phone',r.phone,'role',r.role),?,unixepoch()
      FROM imported_residents r JOIN premises p ON p.id=r.premise_id
      WHERE r.phone=? AND r.claimed_by IS NULL AND p.chat_id=? AND ${guard}
      ON CONFLICT(user_id,premise_id) DO NOTHING`).bind(uid,Number(env.ADMIN_TELEGRAM_USER_ID),phone,chatId,phone,uid),
    env.HOME_DB.prepare(`UPDATE imported_residents SET claimed_by=?,claimed_at=unixepoch()
      WHERE phone=? AND claimed_by IS NULL AND premise_id IN (SELECT id FROM premises WHERE chat_id=?) AND ${guard}`)
      .bind(uid,phone,chatId,phone,uid),
  ]);
  return Number(results[2].meta.changes)>0;
}
