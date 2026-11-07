import { groupCallback, groupMembership } from './groups.ts';
import { adminMenu, cancelPollWizard, pollWizardCallback, pollWizardMessage, startPollWizard } from './poll-wizard.ts';
import type { Env, Message, Update } from './env.ts';
import { createPoll, pollResults, vote } from './polls.ts';
import { pendingRegistrations, registrationCallback, registrationMessage, startRegistration } from './registration.ts';
import { send } from './telegram.ts';
import { positiveId } from './validation.ts';

async function message(env: Env, m: Message, updateId: number) {
  // Never request or echo registration data in a group.
  if (!m.from || m.from.is_bot || m.chat.type !== 'private') return;
  const text = m.text?.trim() || '';
  const [raw, ...args] = text.split(/\s+/);
  const command = raw.split('@')[0];
  if (command === '/id') return send(env, m.chat.id, `Ваш Telegram ID: ${m.from.id}`);
  const admin = String(m.from.id) === env.ADMIN_TELEGRAM_USER_ID;
  if (command === '/start' && admin && !args[0]) return adminMenu(env);
  if (command === '/start' || command === '/register') return startRegistration(env, m.from.id, args[0]);
  if (command === '/cancel') {
    if (admin) await cancelPollWizard(env);
    await env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(m.from.id).run();
    return send(env, m.chat.id, 'Заповнення скасовано. /start — відкрити меню.');
  }
  if (['/poll', '/pending', '/results', '/close'].includes(command)) {
    if (!admin) return send(env, m.chat.id, 'Ця команда доступна лише адміністратору.');
    if (command === '/pending') return pendingRegistrations(env);
    if (command === '/poll') return args.length ? createPoll(env, args.join(' '), updateId) : startPollWizard(env, updateId);
    const id = positiveId(args[0]);
    if (!id) return send(env, m.chat.id, `Формат: ${command} номер_голосування`);
    return pollResults(env, id, command === '/close');
  }
  if (command === '/help') return send(env, m.chat.id, '/start — реєстрація\n/cancel — скасувати заповнення\n/id — ваш Telegram ID' + (admin ? '\n/pending — заявки (перші 20)\n/poll Питання | Так | Ні — опублікувати\n/results ID — результати\n/close ID — завершити' : ''));
  const registration = await env.HOME_DB.prepare('SELECT user_id FROM sessions WHERE user_id=?').bind(m.from.id).first();
  if (registration) return registrationMessage(env, m);
  if (await pollWizardMessage(env, m)) return;
  return registrationMessage(env, m);
}
export async function handleUpdate(env: Env, update: Update) {
  if (update.my_chat_member) return groupMembership(env, update.my_chat_member, update.update_id);
  if (update.callback_query) {
    const q = update.callback_query;
    if (q.from.is_bot) return;
    if (await groupCallback(env, q, update.update_id)) return;
    if (await pollWizardCallback(env, q, update.update_id)) return;
    if (q.data?.startsWith('vote:')) return vote(env, q);
    await registrationCallback(env, q);
  } else if (update.message) await message(env, update.message, update.update_id);
}
export default {
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
