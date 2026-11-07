import { durationLabel, POLL_DURATIONS, validDuration, intervalLabel, REPOST_INTERVALS, validInterval } from './poll-settings.ts';
import { RESIDENT_ACTIONS } from './resident-menu.ts';
import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import type { Button, Callback, Env, Message } from './env.ts';
import { createPoll } from './polls.ts';
import { answer, send, telegram } from './telegram.ts';

interface Draft { token: string; source_update_id: number; step: string; question: string; options: string; chat_id: number | null; group_version: number | null; repost_interval: number | null; duration_days:number|null }
const cancelButton = (token: string): Button[] => [{ text: 'Скасувати', callback_data: `draft:cancel:${token}` }];
export const ADMIN_ACTIONS = {
  poll: '🗳 Створити голосування',
  polls: '📋 Мої голосування',
  pending: '👥 Заявки мешканців',
  groups: '🏘 Мої групи',
  menu: '🏠 Головне меню',
  cancel: '✕ Скасувати заповнення',
};
export async function adminMenu(env: Env) {
  await telegram(env, 'setMyCommands', {
    scope: { type: 'chat', chat_id: Number(env.ADMIN_TELEGRAM_USER_ID) },
    commands: [
      { command: 'menu', description: 'Відкрити головне меню' },
    ],
  });
  await telegram(env, 'setChatMenuButton', { chat_id: Number(env.ADMIN_TELEGRAM_USER_ID), menu_button: { type: 'commands' } });
  return telegram<{ message_id: number }>(env, 'sendMessage', {
    chat_id: env.ADMIN_TELEGRAM_USER_ID,
    text: 'HomeBot 🏡\nОберіть дію на клавіатурі внизу чату.\n\nЯкщо клавіатура прихована, відкрийте її значком біля поля вводу. Або натисніть «Меню» біля поля вводу → «Відкрити головне меню».',
    reply_markup: {
      keyboard: [
        [{ text: ADMIN_ACTIONS.poll }, { text: ADMIN_ACTIONS.polls }],
        [{ text: ADMIN_ACTIONS.pending }, { text: ADMIN_ACTIONS.groups }],
        [{ text: RESIDENT_ACTIONS.data }, { text: RESIDENT_ACTIONS.units }],
        [{ text: RESIDENT_ACTIONS.add }, { text: RESIDENT_ACTIONS.polls }],
        [{ text: ADMIN_ACTIONS.menu }, { text: ADMIN_ACTIONS.cancel }],
      ],
      resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
      input_field_placeholder: 'Оберіть дію або напишіть повідомлення',
    },
  });
}
export async function requestPollWizard(env: Env, updateId: number) {
  const form = await env.HOME_DB.prepare('SELECT user_id FROM sessions WHERE user_id=?').bind(env.ADMIN_TELEGRAM_USER_ID).first();
  if (form) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Спочатку завершіть анкету приміщення або натисніть «Скасувати заповнення». Чернетка голосування зберігається.');
  const old = await draftFor(env);
  if (old && old.step !== 'published') return send(env, env.ADMIN_TELEGRAM_USER_ID, 'У вас є незавершене голосування. Продовжіть його або скасуйте перед створенням нового.', [cancelButton(old.token)]);
  return startPollWizard(env, updateId);
}
export async function startPollWizard(env: Env, updateId: number) {
  const groups = await connectedGroups(env);
  if (!groups.length) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Спочатку підключіть групу: додайте бота до неї та підтвердіть заявку в особистому чаті.');
  const token = crypto.randomUUID().slice(0, 8);
  await env.HOME_DB.prepare(`INSERT INTO poll_drafts(user_id,token,source_update_id,step) VALUES (?,?,?,'question')
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,source_update_id=excluded.source_update_id,step='question',question=NULL,options='[]',chat_id=NULL,group_version=NULL,repost_interval=NULL,duration_days=NULL`)
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
async function durationChoice(env:Env,token:string){
  const buttons:Button[][]=POLL_DURATIONS.map(days=>[{text:durationLabel(days),callback_data:`draft:duration:${token}:${days}`}]);
  buttons.push(cancelButton(token));
  return send(env,env.ADMIN_TELEGRAM_USER_ID,'📅 Скільки триватиме голосування?\n\nПісля завершення бот перестане приймати голоси, опублікує окремий підсумок і прибере повідомлення з кнопками. Час показується за Києвом.',buttons);
}
async function intervalChoice(env: Env, token: string) {
  const buttons:Button[][]=REPOST_INTERVALS.map(seconds=>[{text:intervalLabel(seconds),callback_data:`draft:interval:${token}:${seconds}`}]);
  buttons.push(cancelButton(token));
  return send(env,env.ADMIN_TELEGRAM_USER_ID,'⏱ Як часто піднімати голосування?\n\nБот публікуватиме свіжу копію зі збереженими голосами та прибиратиме стару. Інтервал відраховується від останньої публікації; після ручного підняття відлік починається заново.',buttons);
}
async function preview(env:Env,draft:Draft,groupTitle:string) {
  const options=JSON.parse(draft.options) as string[];
  return send(env,env.ADMIN_TELEGRAM_USER_ID,`Попередній перегляд\nГрупа: ${groupTitle}\n\n${draft.question}\n\n${options.map((o,i)=>`${i+1}. ${o}`).join('\n')}\n\n📅 Тривалість: ${durationLabel(draft.duration_days!)}\n⏱ Підняття: ${intervalLabel(draft.repost_interval!)}\nОдин голос від приміщення.`,[
    [{text:'✅ Опублікувати в групі',callback_data:`draft:publish:${draft.token}`}],
    [{text:'📅 Змінити тривалість',callback_data:`draft:durationmenu:${draft.token}`}],
    [{text:'⏱ Змінити інтервал',callback_data:`draft:intervalmenu:${draft.token}`}],cancelButton(draft.token),
  ]);
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
  if (draft.step === 'duration') { await durationChoice(env,draft.token); return true; }
  if (draft.step === 'interval') { await intervalChoice(env,draft.token); return true; }
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
    await requestPollWizard(env, updateId); return true;
  }
  if (q.data === 'admin:pending') {
    await answer(env, q.id, 'Відкриваю заявки.');
    const { pendingRegistrations } = await import('./registration.ts');
    await pendingRegistrations(env); return true;
  }
  const [, action, token, target, version] = q.data.split(':');
  const draft = await draftFor(env);
  if (!draft || draft.token !== token || draft.step === 'published') {
    await answer(env, q.id, 'Ця чернетка вже недоступна. Відкрийте головне меню кнопкою внизу.'); return true;
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
  if(action==='durationmenu' && draft.step==='preview'){
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='duration' WHERE user_id=? AND token=?").bind(q.from.id,token).run();
    await answer(env,q.id,'Оберіть тривалість.');await durationChoice(env,token);return true;
  }
  if(action==='duration' && draft.step==='duration'){
    const days=Number(target);
    if(!/^\d+$/.test(target||'')||!validDuration(days)){await answer(env,q.id,'Оберіть запропонований строк.');return true;}
    const step=draft.repost_interval===null?'interval':'preview';
    await env.HOME_DB.prepare('UPDATE poll_drafts SET duration_days=?,step=? WHERE user_id=? AND token=?').bind(days,step,q.from.id,token).run();
    await answer(env,q.id,'Строк збережено.');
    if(step==='interval')await intervalChoice(env,token);else await preview(env,{...draft,duration_days:days,step},group.title);
    return true;
  }
  if (action === 'intervalmenu' && draft.step === 'preview') {
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='interval' WHERE user_id=? AND token=?").bind(q.from.id,token).run();
    await answer(env,q.id,'Оберіть інтервал.');await intervalChoice(env,token);return true;
  }
  if (action === 'interval' && draft.step === 'interval') {
    const seconds=Number(target);
    if (!/^\d+$/.test(target || '') || !validInterval(seconds)) { await answer(env,q.id,'Оберіть один із запропонованих інтервалів.');return true; }
    const step=draft.duration_days===null?'duration':'preview';
    await env.HOME_DB.prepare('UPDATE poll_drafts SET repost_interval=?,step=? WHERE user_id=? AND token=?').bind(seconds,step,q.from.id,token).run();
    await answer(env,q.id,'Інтервал збережено.');
    if(step==='duration')await durationChoice(env,token);else await preview(env,{...draft,repost_interval:seconds,step},group.title);return true;
  }
  if (action === 'preview' && ['options','preview'].includes(draft.step) && options.length >= 2) {
    if(draft.duration_days===null){await env.HOME_DB.prepare("UPDATE poll_drafts SET step='duration' WHERE user_id=? AND token=?").bind(q.from.id,token).run();await answer(env,q.id,'Оберіть тривалість.');await durationChoice(env,token);return true;}
    if (draft.repost_interval===null) {
      await env.HOME_DB.prepare("UPDATE poll_drafts SET step='interval' WHERE user_id=? AND token=?").bind(q.from.id,token).run();
      await answer(env,q.id,'Оберіть частоту підняття.');await intervalChoice(env,token);return true;
    }
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='preview' WHERE user_id=? AND token=?").bind(q.from.id,token).run();
    await answer(env,q.id,'Попередній перегляд.');await preview(env,draft,group.title);return true;
  }
  if(action==='publish'&&draft.step==='preview'&&draft.duration_days===null){await env.HOME_DB.prepare("UPDATE poll_drafts SET step='duration' WHERE user_id=? AND token=?").bind(q.from.id,token).run();await answer(env,q.id,'Спочатку оберіть тривалість.');await durationChoice(env,token);return true;}
  if (action === 'publish' && draft.step === 'preview' && draft.repost_interval === null) {
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='interval' WHERE user_id=? AND token=?").bind(q.from.id,token).run();
    await answer(env,q.id,'Спочатку оберіть інтервал підняття.');await intervalChoice(env,token);return true;
  }
  if (action === 'publish' && draft.step === 'preview' && draft.repost_interval !== null && draft.duration_days !== null && options.length >= 2) {
    await answer(env, q.id, 'Публікую голосування.');
    // Stable source ID prevents repeated Publish taps from creating multiple polls.
    const published = await createPoll(env, { question: draft.question, options }, draft.source_update_id, group.chat_id, group.version, draft.repost_interval, draft.duration_days);
    if (!published) return true;
    await env.HOME_DB.prepare("UPDATE poll_drafts SET step='published' WHERE user_id=? AND token=?").bind(q.from.id, token).run();
    await adminMenu(env); return true;
  }
  await answer(env, q.id, 'Спочатку додайте питання та щонайменше два варіанти.');
  return true;
}
