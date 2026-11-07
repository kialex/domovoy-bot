import { retryGroupWelcomes } from './group-welcome.ts';
import { joinRequest, joinCallback, retryJoins } from './join-requests.ts';
import { HOUSE_RESIDENTS, houseResidents, directoryCallback } from './house-residents.ts';
import { adminPollList, pollControls, pollControlCallback, scheduledReposts } from './poll-reposting.ts';
import { RESIDENT_ACTIONS, residentCallback, residentMenu, showOwnData, showOwnUnits, availablePolls, addUnit } from './resident-menu.ts';
import { groupCallback, groupMembership, showGroups } from './groups.ts';
import { ADMIN_ACTIONS, adminMenu, cancelPollWizard, requestPollWizard, pollWizardCallback, pollWizardMessage } from './poll-wizard.ts';
import type { Env, Message, Update } from './env.ts';
import { vote, openVoteIntent, privateVoteCallback } from './polls.ts';
import { pendingRegistrations, registrationCallback, registrationMessage, resumeRegistration, startRegistration } from './registration.ts';
import { send } from './telegram.ts';
import { positiveId } from './validation.ts';

async function message(env: Env, m: Message, updateId: number) {
  // Never request or echo registration data in a group.
  if (!m.from || m.from.is_bot || m.chat.type !== 'private') return;
  const text = m.text?.trim() || '';
  const [raw, ...args] = text.split(/\s+/);
  const command = raw.split('@')[0];
  if (command === '/start' && args[0]?.startsWith('vote_')) return openVoteIntent(env, m.from.id, args[0].slice(5));
  if (command === '/id') return send(env, m.chat.id, `Ваш Telegram ID: ${m.from.id}`);
  const admin = String(m.from.id) === env.ADMIN_TELEGRAM_USER_ID;
  if (admin && (command === '/menu' || text === ADMIN_ACTIONS.menu)) return adminMenu(env);
  if (admin && (text === ADMIN_ACTIONS.polls || command === '/polls')) return adminPollList(env);
  if (admin && text === '🗳 Активні голосування') return adminPollList(env,0,'open');
  if (admin && text === '🏁 Завершені голосування') return adminPollList(env,0,'closed');
  if (admin && text === ADMIN_ACTIONS.poll) return requestPollWizard(env, updateId);
  if (admin && text === ADMIN_ACTIONS.pending) return pendingRegistrations(env);
  if (admin && text === HOUSE_RESIDENTS) return houseResidents(env);
  if (admin && text === ADMIN_ACTIONS.groups) return showGroups(env);
  if (text === RESIDENT_ACTIONS.data) return showOwnData(env, m.from.id);
  if (text === RESIDENT_ACTIONS.units) return showOwnUnits(env, m.from.id);
  if (text === RESIDENT_ACTIONS.polls) return availablePolls(env, m.from.id);
  if (text === RESIDENT_ACTIONS.add) return addUnit(env, m.from.id);
  if (text === RESIDENT_ACTIONS.menu || (!admin && command === '/menu')) return residentMenu(env, m.from.id);
  if (command === '/start' && admin && !args[0]) return adminMenu(env);
  if (command === '/start' && !args[0]) {
    const joining=await env.HOME_DB.prepare("SELECT j.chat_id FROM join_requests j JOIN groups g ON g.chat_id=j.chat_id WHERE j.user_id=? AND j.status='pending' AND j.decision='' AND g.status='approved' AND g.bot_present=1 ORDER BY j.update_id DESC LIMIT 1").bind(m.from.id).first<{chat_id:number}>();
    if(joining)return resumeRegistration(env,m.from.id,joining.chat_id);
    const profile = await env.HOME_DB.prepare('SELECT user_id FROM profiles WHERE user_id=?').bind(m.from.id).first();
    if (profile) return residentMenu(env, m.from.id);
  }
  if (command === '/start' || command === '/register') return startRegistration(env, m.from.id, args[0]);
  if (command === '/cancel' || (admin && text === ADMIN_ACTIONS.cancel)) {
    if (admin) await cancelPollWizard(env);
    await env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(m.from.id).run();
    if (admin) return adminMenu(env);
    return residentMenu(env, m.from.id);
  }
  if (['/poll', '/pending', '/results', '/close'].includes(command)) {
    if (!admin) return send(env, m.chat.id, 'Ця команда доступна лише адміністратору.');
    if (command === '/pending') return pendingRegistrations(env);
    if (command === '/poll') return requestPollWizard(env, updateId);
    const id = positiveId(args[0]);
    return id ? pollControls(env,id) : adminPollList(env);
  }
  if (command === '/help') return admin ? adminMenu(env) : residentMenu(env,m.from.id);
  const registration = await env.HOME_DB.prepare('SELECT user_id FROM sessions WHERE user_id=?').bind(m.from.id).first();
  if (registration) return registrationMessage(env, m);
  if (await pollWizardMessage(env, m)) return;
  return registrationMessage(env, m);
}
export async function handleUpdate(env: Env, update: Update) {
  const privateMessage=update.message||update.callback_query?.message;
  const sender=update.message?.from||update.callback_query?.from;
  if(privateMessage?.chat.type==='private'&&sender&&!sender.is_bot){
    await env.HOME_DB.prepare('INSERT INTO private_chats VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id').bind(sender.id,privateMessage.chat.id).run();
    // Telegram's join-request private chat identifier may differ from the user ID.
    // Route by authenticated sender; outbound messages use the stored chat identifier.
    privateMessage.chat={...privateMessage.chat,id:sender.id};
  }
  if(update.chat_join_request)return joinRequest(env,update.chat_join_request,update.update_id);
  if (update.my_chat_member) return groupMembership(env, update.my_chat_member, update.update_id);
  if (update.callback_query) {
    const q = update.callback_query;
    if (q.from.is_bot) return;
    if (await joinCallback(env,q)) return;
    if (await directoryCallback(env,q)) return;
    if (await pollControlCallback(env,q,update.update_id)) return;
    if (await privateVoteCallback(env, q)) return;
    if (await residentCallback(env, q)) return;
    if (await groupCallback(env, q, update.update_id)) return;
    if (await pollWizardCallback(env, q, update.update_id)) return;
    if (q.data?.startsWith('vote:')) return vote(env, q);
    await registrationCallback(env, q);
  } else if (update.message) await message(env, update.message, update.update_id);
}
export default {
  async scheduled(_event:unknown,env:Env):Promise<void> {
    await scheduledReposts(env);
    await retryJoins(env);
    await retryGroupWelcomes(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return Response.json({ service: 'homebot', status: 'ok' });
    if (path !== '/telegram/webhook') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response(null, { status: 403 });
    if (!env.HOME_DB || !env.TELEGRAM_BOT_TOKEN || !positiveId(env.ADMIN_TELEGRAM_USER_ID)) return new Response('Configuration required', { status: 503 });
    let update: Update;
    try { update = await request.json() as Update; }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return new Response('Invalid update', { status: 400 });
    try {
      const result = await env.HOME_DB.prepare(`INSERT INTO updates(id,state) VALUES (?,'processing')
        ON CONFLICT(id) DO UPDATE SET claimed_at=unixepoch()
        WHERE updates.state='processing' AND updates.claimed_at < unixepoch()-60`).bind(update.update_id).run();
      if (!result.meta.changes) {
        const old = await env.HOME_DB.prepare('SELECT state FROM updates WHERE id=?').bind(update.update_id).first<{ state: string }>();
        return new Response(null, { status: old?.state === 'done' ? 200 : 503 });
      }
      try {
        await handleUpdate(env, update);
        await env.HOME_DB.prepare("UPDATE updates SET state='done' WHERE id=?").bind(update.update_id).run();
      } catch {
        await env.HOME_DB.prepare("DELETE FROM updates WHERE id=? AND state='processing'").bind(update.update_id).run();
        throw new Error('Update failed');
      }
      return new Response('OK');
    } catch {
      console.error('Telegram update failed', { updateId: update.update_id });
      return new Response('Retry later', { status: 503 });
    }
  },
};
