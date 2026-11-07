import type { Callback, Env, Message } from './env.ts';
import { connectedGroups, getGroup, groupId, isConnected } from './groups.ts';
import { answer, send } from './telegram.ts';
import { apartmentNumber, positiveId } from './validation.ts';

interface Resident { user_id: number; chat_id: number; name: string; apartment: string; role: string; status: string; application_token: string }
interface Session { step: string; name: string; apartment: string; chat_id: number; token: string }
const roleButtons = (token: string) => [[{ text: 'Власник', callback_data: `role:owner:${token}` }, { text: 'Орендар', callback_data: `role:tenant:${token}` }]];
const reviewButtons = (r: Resident) => [[
  { text: 'Підтвердити', callback_data: `approve:${r.user_id}:${r.chat_id}:${r.application_token}` },
  { text: 'Відхилити', callback_data: `reject:${r.user_id}:${r.chat_id}:${r.application_token}` },
]];
export async function startRegistration(env: Env, uid: number, payload?: string) {
  let chatId: number | null = null;
  if (payload?.startsWith('poll_')) {
    const id = positiveId(payload.slice(5));
    const poll = id ? await env.HOME_DB.prepare('SELECT chat_id FROM polls WHERE id=?').bind(id).first<{ chat_id: number }>() : null;
    chatId = poll?.chat_id || null;
  } else if (payload?.startsWith('group_')) chatId = groupId(`-${payload.slice(6)}`);
  else {
    const groups = await connectedGroups(env);
    if (groups.length === 1) chatId = groups[0].chat_id;
    else return send(env, uid, groups.length ? 'Для реєстрації відкрийте бота кнопкою під голосуванням у потрібній групі. Так заявка потрапить до правильного будинку.' : 'Поки немає підключених груп. Зверніться до адміністратора.');
  }
  const group = chatId ? await getGroup(env, chatId) : null;
  if (!isConnected(group)) return send(env, uid, 'Ця група ще не підключена або вже від’єднана. Зверніться до адміністратора.');
  const resident = await env.HOME_DB.prepare('SELECT * FROM residents WHERE user_id=? AND chat_id=?').bind(uid, chatId).first<Resident>();
  if (resident?.status === 'approved') return send(env, uid, `Ви вже зареєстровані в групі «${group.title}». Голосуйте кнопками в цій групі.`);
  if (resident?.status === 'pending') return send(env, uid, `Заявка для групи «${group.title}» очікує підтвердження адміністратора.`);
  const token = crypto.randomUUID().slice(0, 8);
  await env.HOME_DB.prepare(`INSERT INTO sessions(user_id,step,chat_id,token) VALUES (?,'name',?,?)
    ON CONFLICT(user_id) DO UPDATE SET step='name',name=NULL,apartment=NULL,chat_id=excluded.chat_id,token=excluded.token,updated_at=unixepoch()`)
    .bind(uid, chatId, token).run();
  return send(env, uid, `Реєстрація в групі «${group.title}». Ім’я, квартира та статус будуть доступні адміністратору для перевірки та обліку голосів. Надсилаючи їх, ви погоджуєтесь на це використання.\n\nЯк вас звати?\n/cancel — скасувати.`);
}
export async function registrationMessage(env: Env, message: Message) {
  const uid = message.from!.id;
  const session = await env.HOME_DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(uid).first<Session>();
  if (!session) return send(env, uid, 'Для реєстрації натисніть /start.');
  if (!isConnected(await getGroup(env, session.chat_id))) return send(env, uid, 'Групу від’єднано. Реєстрація для неї зараз недоступна.');
  const value = message.text?.trim() || '';
  if (session.step === 'name') {
    if (value.length < 2 || value.length > 100 || value.startsWith('/')) return send(env, uid, 'Введіть ім’я: від 2 до 100 символів.');
    await env.HOME_DB.prepare("UPDATE sessions SET name=?,step='apartment',updated_at=unixepoch() WHERE user_id=? AND token=? AND step='name'").bind(value, uid, session.token).run();
    return send(env, uid, 'Вкажіть номер квартири (лише цифри).');
  }
  if (session.step === 'apartment') {
    const apartment = apartmentNumber(value);
    if (!apartment) return send(env, uid, 'Введіть номер квартири від 1 до 99999.');
    await env.HOME_DB.prepare("UPDATE sessions SET apartment=?,step='role',updated_at=unixepoch() WHERE user_id=? AND token=? AND step='apartment'").bind(apartment, uid, session.token).run();
  }
  return send(env, uid, 'Оберіть ваш статус:', roleButtons(session.token));
}
export async function registrationCallback(env: Env, query: Callback): Promise<boolean> {
  const uid = query.from.id;
  const [action, value, scope, applicationToken] = (query.data || '').split(':');
  if (action === 'role') {
    if (query.message?.chat.type !== 'private' || query.message.chat.id !== uid || !['owner','tenant'].includes(value)) {
      await answer(env, query.id, 'Недоступна дія.'); return true;
    }
    const session = await env.HOME_DB.prepare("SELECT * FROM sessions WHERE user_id=? AND step='role' AND token=?").bind(uid, scope || '').first<Session>();
    const group = session ? await getGroup(env, session.chat_id) : null;
    if (!session || !isConnected(group)) { await answer(env, query.id, 'Ця реєстрація недоступна. Почніть знову з потрібної групи.'); return true; }
    await env.HOME_DB.batch([
      env.HOME_DB.prepare(`INSERT INTO residents(user_id,chat_id,name,apartment,role,application_token) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,chat_id) DO UPDATE SET name=excluded.name,apartment=excluded.apartment,role=excluded.role,
        application_token=excluded.application_token,status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE residents.status='rejected'`)
        .bind(uid, session.chat_id, session.name, session.apartment, value, session.token),
      env.HOME_DB.prepare('DELETE FROM sessions WHERE user_id=? AND token=?').bind(uid, session.token),
    ]);
    await answer(env, query.id, 'Заявку збережено.');
    await send(env, uid, `Заявку для групи «${group.title}» передано на перевірку. Після підтвердження ви зможете голосувати в ній.`);
    const resident = await env.HOME_DB.prepare('SELECT * FROM residents WHERE user_id=? AND chat_id=?').bind(uid, session.chat_id).first<Resident>();
    if (resident) await send(env, env.ADMIN_TELEGRAM_USER_ID, `Нова заявка: ${group.title}\nІм’я: ${session.name}\nКвартира: ${session.apartment}\nСтатус: ${value === 'owner' ? 'власник' : 'орендар'}\nTelegram ID: ${uid}`, reviewButtons(resident));
    return true;
  }
  if (!['approve','reject'].includes(action)) return false;
  if (String(uid) !== env.ADMIN_TELEGRAM_USER_ID || query.message?.chat.type !== 'private' || query.message.chat.id !== uid) {
    await answer(env, query.id, 'Лише для адміністратора.'); return true;
  }
  const target = positiveId(value);
  const chatId = groupId(scope);
  const group = chatId ? await getGroup(env, chatId) : null;
  if (!target || !isConnected(group) || !applicationToken) { await answer(env, query.id, 'Некоректна заявка або групу від’єднано.'); return true; }
  const status = action === 'approve' ? 'approved' : 'rejected';
  const result = await env.HOME_DB.prepare("UPDATE residents SET status=?,reviewed_by=?,reviewed_at=unixepoch() WHERE user_id=? AND chat_id=? AND application_token=? AND status='pending'").bind(status, uid, target, chatId, applicationToken).run();
  await answer(env, query.id, result.meta.changes ? 'Рішення збережено.' : 'Заявку вже розглянуто або ця кнопка застаріла.');
  if (result.meta.changes) await send(env, target, status === 'approved' ? `Реєстрацію для групи «${group.title}» підтверджено! Тепер ви можете голосувати в ній.` : `Заявку для групи «${group.title}» відхилено. Зверніться до адміністратора.`);
  return true;
}
export async function pendingRegistrations(env: Env) {
  const { results } = await env.HOME_DB.prepare("SELECT r.*,g.title FROM residents r JOIN groups g ON g.chat_id=r.chat_id WHERE r.status='pending' AND g.status='approved' AND g.bot_present=1 ORDER BY r.created_at LIMIT 20").all<Resident & { title: string }>();
  if (!results.length) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Нових заявок немає.');
  for (const r of results) await send(env, env.ADMIN_TELEGRAM_USER_ID, `${r.title}\n${r.name}\nКвартира: ${r.apartment}\n${r.role === 'owner' ? 'Власник' : 'Орендар'}`, reviewButtons(r));
}
