import type { Button, Callback, ChatMemberUpdate, Env } from './env.ts';
import { answer, send } from './telegram.ts';

export interface Group { chat_id: number; title: string; status: string; bot_present: number; version: number }
export function groupId(value: string | undefined): number | null {
  if (!value || !/^-[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
export function getGroup(env: Env, id: number) {
  return env.HOME_DB.prepare('SELECT * FROM groups WHERE chat_id=?').bind(id).first<Group>();
}
export async function connectedGroups(env: Env) {
  return (await env.HOME_DB.prepare("SELECT * FROM groups WHERE status='approved' AND bot_present=1 ORDER BY title,chat_id").all<Group>()).results;
}
export function isConnected(group: Group | null): group is Group {
  return !!group && group.status === 'approved' && group.bot_present === 1;
}
const label = (g: Group) => `${g.title}\nID: ${g.chat_id}`;
function controls(g: Group): Button[][] {
  if (!g.bot_present) return [];
  if (g.status === 'approved') return [[{ text: 'Від’єднати групу', callback_data: `group:askdisconnect:${g.chat_id}:${g.version}` }]];
  return [
    [{ text: '✅ Підключити', callback_data: `group:approve:${g.chat_id}:${g.version}` }],
    ...(g.status === 'pending' ? [[{ text: 'Відхилити', callback_data: `group:reject:${g.chat_id}:${g.version}` }]] : []),
  ];
}
export async function groupMembership(env: Env, event: ChatMemberUpdate, updateId: number) {
  if (!['group', 'supergroup'].includes(event.chat.type)) return;
  const present = ['member', 'administrator', 'creator'].includes(event.new_chat_member.status) ||
    (event.new_chat_member.status === 'restricted' && event.new_chat_member.is_member === true);
  const previous = await getGroup(env, event.chat.id);
  const oldPresent = ['member', 'administrator', 'creator'].includes(event.old_chat_member.status) ||
    (event.old_chat_member.status === 'restricted' && event.old_chat_member.is_member === true);
  const joined = present && (!oldPresent || !previous || previous.bot_present === 0);
  const title = event.chat.title || String(event.chat.id);
  const status = !present ? 'removed' : joined ? 'pending' : previous?.status || 'pending';
  const version = !present || joined ? updateId : previous?.version || updateId;
  const result = await env.HOME_DB.prepare(`INSERT INTO groups(chat_id,title,status,bot_present,added_by,version,last_event_id)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,status=excluded.status,
    bot_present=excluded.bot_present,added_by=excluded.added_by,version=excluded.version,last_event_id=excluded.last_event_id
    WHERE groups.last_event_id < excluded.last_event_id`)
    .bind(event.chat.id, title, status, Number(present), event.from.id, version, updateId).run();
  if (!result.meta.changes) return;
  if (!present) {
    await env.HOME_DB.prepare("UPDATE polls SET status='closed' WHERE chat_id=? AND status='open'").bind(event.chat.id).run();
    if (previous?.status === 'approved') await send(env, env.ADMIN_TELEGRAM_USER_ID, `Бота видалено з групи ${title}. Підключення вимкнено, відкриті голосування закрито.`);
    return;
  }
  if (joined) await send(env, env.ADMIN_TELEGRAM_USER_ID, `Заявка на підключення групи\n\n${title}\nID: ${event.chat.id}\nДодав користувач: ${event.from.id}\n\nПідключити цю групу до HomeBot?`, controls({ chat_id: event.chat.id, title, status, bot_present: 1, version }));
}
export async function showGroups(env: Env, page = 0) {
  const { results } = await env.HOME_DB.prepare('SELECT * FROM groups ORDER BY title,chat_id LIMIT 11 OFFSET ?').bind(page * 10).all<Group>();
  if (!results.length) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Груп ще немає. Додайте бота до групи — тут з’явиться заявка на підключення.');
  const names: Record<string, string> = { approved: '✅', pending: '⏳', rejected: '❌', disconnected: '⏸', removed: '🚪' };
  const buttons: Button[][] = results.slice(0, 10).map(g => [{ text: `${names[g.status] || ''} ${g.title}`.slice(0, 60), callback_data: `group:show:${g.chat_id}` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `groups:${page - 1}` });
  if (results.length > 10) nav.push({ text: 'Далі →', callback_data: `groups:${page + 1}` });
  if (nav.length) buttons.push(nav);
  return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Групи будинку\nОберіть групу для керування підключенням.', buttons);
}
export async function groupCallback(env: Env, q: Callback, updateId: number): Promise<boolean> {
  if (q.data !== 'admin:groups' && !q.data?.startsWith('group:') && !q.data?.startsWith('groups:')) return false;
  if (String(q.from.id) !== env.ADMIN_TELEGRAM_USER_ID || q.message?.chat.type !== 'private' || q.message.chat.id !== q.from.id) {
    await answer(env, q.id, 'Лише для адміністратора в особистому чаті.'); return true;
  }
  if (q.data === 'admin:groups' || q.data.startsWith('groups:')) {
    const page = q.data === 'admin:groups' ? 0 : Number(q.data.split(':')[1]);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) { await answer(env, q.id, 'Недоступна сторінка.'); return true; }
    await answer(env, q.id, 'Ваші групи.'); await showGroups(env, page); return true;
  }
  const [, action, rawId, rawVersion] = q.data.split(':');
  const id = groupId(rawId);
  const g = id ? await getGroup(env, id) : null;
  if (!g) { await answer(env, q.id, 'Групу не знайдено.'); return true; }
  if (action === 'show') {
    await answer(env, q.id, 'Налаштування групи.');
    const status: Record<string, string> = { approved: 'Підключено', pending: 'Очікує рішення', rejected: 'Відхилено', disconnected: 'Від’єднано', removed: 'Бота видалено. Додайте його до групи знову.' };
    await send(env, q.from.id, `${label(g)}\n\n${status[g.status]}`, controls(g)); return true;
  }
  if (!g.bot_present || Number(rawVersion) !== g.version) {
    await answer(env, q.id, 'Ця кнопка застаріла. Відкрийте налаштування групи знову.'); return true;
  }
  if (action === 'askdisconnect' && g.status === 'approved') {
    await answer(env, q.id, 'Підтвердіть від’єднання.');
    await send(env, q.from.id, `Від’єднати групу ${g.title}?\nВідкриті голосування буде закрито. Реєстр мешканців та результати залишаться в історії.`, [[
      { text: 'Так, від’єднати', callback_data: `group:disconnect:${id}:${g.version}` },
      { text: 'Залишити підключеною', callback_data: `group:show:${id}` },
    ]]); return true;
  }
  if (action === 'approve' && ['pending', 'rejected', 'disconnected'].includes(g.status)) {
    await env.HOME_DB.prepare("UPDATE groups SET status='approved',version=? WHERE chat_id=? AND version=? AND bot_present=1").bind(updateId, id, g.version).run();
    await answer(env, q.id, 'Групу підключено.');
    await send(env, q.from.id, `✅ ${g.title} підключено. Ця група доступна при створенні голосування.`); return true;
  }
  if (action === 'reject' && g.status === 'pending') {
    await env.HOME_DB.prepare("UPDATE groups SET status='rejected',version=? WHERE chat_id=? AND version=?").bind(updateId, id, g.version).run();
    await answer(env, q.id, 'Заявку відхилено.'); return true;
  }
  if (action === 'disconnect' && g.status === 'approved') {
    await env.HOME_DB.batch([
      env.HOME_DB.prepare("UPDATE groups SET status='disconnected',version=? WHERE chat_id=? AND version=?").bind(updateId, id, g.version),
      env.HOME_DB.prepare("UPDATE polls SET status='closed' WHERE chat_id=? AND status='open'").bind(id),
    ]);
    await answer(env, q.id, 'Групу від’єднано.');
    await send(env, q.from.id, `${g.title} від’єднано. Інші групи залишаються підключеними.`); return true;
  }
  await answer(env, q.id, 'Дію вже виконано або вона недоступна.'); return true;
}
