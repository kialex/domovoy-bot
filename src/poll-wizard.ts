import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import type { Button, Callback, Env, Message } from './env.ts';
import { createPoll } from './polls.ts';
import { answer, send } from './telegram.ts';

interface Draft { token: string; source_update_id: number; step: string; question: string; options: string; chat_id: number | null; group_version: number | null }
const cancelButton = (token: string): Button[] => [{ text: 'Скасувати', callback_data: `draft:cancel:${token}` }];
export function adminMenu(env: Env) {
  return send(env, env.ADMIN_TELEGRAM_USER_ID, 'HomeBot 🏡\nЩо бажаєте зробити?', [
    [{ text: '🗳 Створити голосування', callback_data: 'admin:newpoll' }],
    [{ text: '👥 Заявки мешканців', callback_data: 'admin:pending' }],
    [{ text: '🏘 Мої групи', callback_data: 'admin:groups' }],
  ]);
}
export async function startPollWizard(env: Env, updateId: number) {
  const groups = await connectedGroups(env);
  if (!groups.length) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Спочатку підключіть групу: додайте бота до неї та підтвердіть заявку в особистому чаті.', [[{ text: 'Мої групи', callback_data: 'admin:groups' }]]);
  const token = crypto.randomUUID().slice(0, 8);
  await env.HOME_DB.prepare(`INSERT INTO poll_drafts(user_id,token,source_update_id,step) VALUES (?,?,?,'question')
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,source_update_id=excluded.source_update_id,step='question',question=NULL,options='[]',chat_id=NULL,group_version=NULL`)
    .bind(env.ADMIN_TELEGRAM_USER_ID, token, updateId).run();
  if (groups.length > 1) return choosePollGroup(env, token);
  await env.HOME_DB.prepare('UPDATE poll_drafts SET chat_id=?,group_version=? WHERE user_id=? AND token=?').bind(groups[0].chat_id, groups[0].version, env.ADMIN_TELEGRAM_USER_ID, token).run();
  return send(env, env.ADMIN_TELEGRAM_USER_ID, `Група: ${groups[0].title}\n\nНапишіть питання для голосування (до 300 символів).`, [cancelButton(token)]);
}
async function choosePollGroup(env: Env, token: string, page = 0) {
  const groups = await connectedGroups(env);
  const buttons: Button[][] = groups.slice(page * 10, page * 10 + 10).map(g => [{ text: g.title.slice(0, 60), callback_data: `draft:group:${token}:${g.chat_id}:${g.version}` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `draft:groups:${token}:${page - 1}` });
  if (groups.length > page * 10 + 10) nav.push({ text: 'Далі →', callback_data: `draft:groups:${token}:${page + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push(cancelButton(token));
  return send(env, env.ADMIN_TELEGRAM_USER_ID, 'У якій групі опублікувати голосування?', buttons);
}
export async function cancelPollWizard(env: Env) {
  await env.HOME_DB.prepare('DELETE FROM poll_drafts WHERE user_id=?').bind(env.ADMIN_TELEGRAM_USER_ID).run();
}
async function draftFor(env: Env) {
  return env.HOME_DB.prepare('SELECT * FROM poll_drafts WHERE user_id=?').bind(env.ADMIN_TELEGRAM_USER_ID).first<Draft>();
}
export async function pollWizardMessage(env: Env, message: Message): Promise<boolean> {
  if (String(message.from?.id) !== env.ADMIN_TELEGRAM_USER_ID || message.chat.type !== 'private') return false;
  const draft = await draftFor(env);
  if (!draft || draft.step === 'published') return false;
  if (!draft.chat_id) { await choosePollGroup(env, draft.token); return true; }
  const text = message.text?.trim() || '';
  if (draft.step === 'preview') {
    await send(env, message.chat.id, 'Перевірте попередній перегляд і натисніть «Опублікувати» або «Скасувати».');
    return true;
  }
  if (draft.step === 'question') {
    if (!text || text.length > 300) {
      await send(env, message.chat.id, 'Надішліть текст питання від 1 до 300 символів.'); return true;
    }
    await env.HOME_DB.prepare("UPDATE poll_drafts SET question=?, step='options' WHERE user_id=? AND token=?").bind(text, message.from!.id, draft.token).run();
    await send(env, message.chat.id, 'Тепер надішліть перший варіант відповіді. Кожен варіант — окремим повідомленням (від 2 до 8 варіантів).', [cancelButton(draft.token)]);
    return true;
  }
  const options = JSON.parse(draft.options) as string[];
  if (!text || text.length > 60 || options.includes(text) || options.length >= 8) {
    await send(env, message.chat.id, 'Варіант має містити від 1 до 60 символів та не повторювати інші. Максимум 8 варіантів.', [
      ...(options.length >= 2 ? [[{ text: 'Готово — переглянути', callback_data: `draft:preview:${draft.token}` }]] : []), cancelButton(draft.token),
    ]); return true;
  }
  options.push(text);
  await env.HOME_DB.prepare('UPDATE poll_drafts SET options=? WHERE user_id=? AND token=?').bind(JSON.stringify(options), message.from!.id, draft.token).run();
  await send(env, message.chat.id, `Варіанти:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n${options.length < 2 ? 'Надішліть ще один варіант.' : options.length < 8 ? 'Додайте ще варіант або натисніть «Готово».' : 'Усі 8 варіантів додано. Натисніть «Готово».'}`, [
    ...(options.length >= 2 ? [[{ text: 'Готово — переглянути', callback_data: `draft:preview:${draft.token}` }]] : []), cancelButton(draft.token),
  ]);
  return true;
}
export async function pollWizardCallback(env: Env, q: Callback, updateId: number): Promise<boolean> {
  if (!q.data?.startsWith('draft:') && !q.data?.startsWith('admin:')) return false;
  if (String(q.from.id) !== env.ADMIN_TELEGRAM_USER_ID || q.message?.chat.type !== 'private' || q.message.chat.id !== q.from.id) {
    await answer(env, q.id, 'Лише для адміністратора в особистому чаті.'); return true;
  }
  if (q.data === 'admin:newpoll') {
    // An active draft must be explicitly cancelled before starting another.
    const old = await draftFor(env);
    if (old && old.step !== 'published') {
      await answer(env, q.id, 'Спочатку завершіть або скасуйте поточне голосування.'); return true;
    }
    await answer(env, q.id, 'Створюємо голосування.');
    await startPollWizard(env, updateId); return true;
  }
  if (q.data === 'admin:pending') {
    await answer(env, q.id, 'Відкриваю заявки.');
    const { pendingRegistrations } = await import('./registration.ts');
    await pendingRegistrations(env); return true;
  }
  const [, action, token, target, version] = q.data.split(':');
  const draft = await draftFor(env);
  if (!draft || draft.token !== token || draft.step === 'published') {
    await answer(env, q.id, 'Ця чернетка вже недоступна. Відкрийте меню: /start.'); return true;
  }
  if (action === 'cancel') {
    await cancelPollWizard(env); await answer(env, q.id, 'Створення скасовано.'); await adminMenu(env); return true;
  }
  if (action === 'groups' && !draft.chat_id) {
    const page = Number(target);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) { await answer(env, q.id, 'Недоступна сторінка.'); return true; }
    await answer(env, q.id, 'Оберіть групу.'); await choosePollGroup(env, token, page); return true;
  }
  if (action === 'group' && !draft.chat_id && draft.step === 'question') {
    const id = groupId(target);
    const group = id ? await getGroup(env, id) : null;
    if (!isConnected(group) || group.version !== Number(version)) { await answer(env, q.id, 'Це підключення вже недоступне. Оберіть іншу групу.'); return true; }
    await env.HOME_DB.prepare('UPDATE poll_drafts SET chat_id=?,group_version=? WHERE user_id=? AND token=? AND chat_id IS NULL').bind(id, group.version, q.from.id, token).run();
    await answer(env, q.id, 'Групу обрано.');
    await send(env, q.from.id, `Група: ${group.title}\n\nНапишіть питання для голосування (до 300 символів).`, [cancelButton(token)]); return true;
  }
  const group = draft.chat_id ? await getGroup(env, draft.chat_id) : null;
  if (!isConnected(group) || group.version !== draft.group_version) {
    await answer(env, q.id, 'Підключення групи змінилося. Скасуйте чернетку та оберіть групу знову.'); return true;
  }
  const options = JSON.parse(draft.options) as string[];
  if (action === 'preview' && ['options', 'preview'].includes(draft.step) && options.length >= 2) {
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='preview' WHERE user_id=? AND token=?").bind(q.from.id, token).run();
    await answer(env, q.id, 'Попередній перегляд.');
    await send(env, q.from.id, `Попередній перегляд\nГрупа: ${group.title}\n\n${draft.question}\n\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nОдин голос від квартири. Після публікації мешканці отримають це голосування в групі.`, [
      [{ text: '✅ Опублікувати в групі', callback_data: `draft:publish:${token}` }], cancelButton(token),
    ]); return true;
  }
  if (action === 'publish' && draft.step === 'preview' && options.length >= 2) {
    await answer(env, q.id, 'Публікую голосування.');
    // Stable source ID prevents repeated Publish taps from creating multiple polls.
    const published = await createPoll(env, { question: draft.question, options }, draft.source_update_id, group.chat_id, group.version);
    if (!published) return true;
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='published' WHERE user_id=? AND token=?").bind(q.from.id, token).run();
    await adminMenu(env); return true;
  }
  await answer(env, q.id, 'Спочатку додайте питання та щонайменше два варіанти.');
  return true;
}
