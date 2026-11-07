import { connectedGroups, getGroup, isConnected } from './groups.ts';
import type { Callback, Env } from './env.ts';
import { answer, registrationUrl, send, telegram } from './telegram.ts';
import { parsePoll, positiveId } from './validation.ts';

interface Poll { id: number; question: string; options: string; chat_id: number; message_id: number | null; status: string }
export async function createPoll(env: Env, input: string | { question: string; options: string[] }, updateId: number, chatId?: number, groupVersion?: number) {
  const parsed = typeof input === 'string' ? parsePoll(input) : input;
  if (!parsed) return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Формат: /poll Питання | Варіант 1 | Варіант 2\nВід 2 до 8 різних варіантів (до 60 символів), питання — до 300 символів.');
  if (!chatId) {
    const groups = await connectedGroups(env);
    if (groups.length !== 1) {
      await send(env, env.ADMIN_TELEGRAM_USER_ID, 'Оберіть групу через покрокове створення голосування.', [[{ text: 'Створити голосування', callback_data: 'admin:newpoll' }]]);
      return false;
    }
    chatId = groups[0].chat_id;
  }
  const group = await getGroup(env, chatId);
  if (!isConnected(group) || (groupVersion !== undefined && group.version !== groupVersion)) {
    await send(env, env.ADMIN_TELEGRAM_USER_ID, 'Підключення цієї групи змінилося. Створіть нову чернетку й оберіть групу знову.'); return false;
  }
  await env.HOME_DB.prepare('INSERT INTO polls(question,options,chat_id,created_by,source_update_id) VALUES (?,?,?,?,?) ON CONFLICT(source_update_id) DO NOTHING')
    .bind(parsed.question, JSON.stringify(parsed.options), chatId, env.ADMIN_TELEGRAM_USER_ID, updateId).run();
  const poll = await env.HOME_DB.prepare('SELECT * FROM polls WHERE source_update_id=?').bind(updateId).first<Poll>();
  if (!poll) throw new Error('Poll creation failed');
  if (poll.message_id) return true;
  if (poll.chat_id !== chatId || poll.status !== 'draft') return false;
  const message = await send(env, poll.chat_id, `Голосування №${poll.id}\n\n${poll.question}\n\nОдин голос від квартири. Вибір можна змінити до завершення.`, [
    ...parsed.options.map((text, index) => [{ text, callback_data: `vote:${poll.id}:${index}` }]),
    [{ text: 'Реєстрація мешканця', url: await registrationUrl(env, poll.id) }],
  ]);
  await env.HOME_DB.prepare("UPDATE polls SET message_id=?, status='open' WHERE id=? AND status='draft'").bind(message.message_id, poll.id).run();
  await send(env, env.ADMIN_TELEGRAM_USER_ID, `Голосування №${poll.id} опубліковано в групі «${group.title}».\n/results ${poll.id} — результати\n/close ${poll.id} — завершити`);
  return true;
}
export async function vote(env: Env, query: Callback) {
  const [, rawId, rawOption] = (query.data || '').split(':');
  const pollId = positiveId(rawId);
  const option = /^\d+$/.test(rawOption || '') ? Number(rawOption) : -1;
  const poll = pollId ? await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(pollId).first<Poll>() : null;
  if (!poll || poll.status !== 'open' || !query.message || query.message.chat.id !== poll.chat_id || query.message.message_id !== poll.message_id) {
    return answer(env, query.id, 'Голосування недоступне або завершене.');
  }
  if (!isConnected(await getGroup(env, poll.chat_id))) return answer(env, query.id, 'Цю групу від’єднано.');
  const options = JSON.parse(poll.options) as string[];
  if (!Number.isInteger(option) || option < 0 || option >= options.length) return answer(env, query.id, 'Некоректний варіант.');
  const resident = await env.HOME_DB.prepare("SELECT apartment FROM residents WHERE user_id=? AND chat_id=? AND status='approved'").bind(query.from.id, poll.chat_id).first<{ apartment: string }>();
  if (!resident) return answer(env, query.id, 'Для голосування пройдіть реєстрацію та дочекайтеся підтвердження.', await registrationUrl(env, poll.id));
  // The conditional INSERT and unique key enforce eligibility and one apartment vote atomically.
  const result = await env.HOME_DB.prepare(`INSERT INTO votes(poll_id,apartment,user_id,option_index)
    SELECT p.id,r.apartment,r.user_id,? FROM polls p,residents r
    WHERE p.id=? AND p.status='open' AND r.user_id=? AND r.chat_id=p.chat_id AND r.status='approved'
      AND EXISTS (SELECT 1 FROM groups g WHERE g.chat_id=p.chat_id AND g.status='approved' AND g.bot_present=1)
    ON CONFLICT(poll_id,apartment) DO UPDATE SET option_index=excluded.option_index,updated_at=unixepoch()
    WHERE votes.user_id=excluded.user_id`).bind(option, pollId, query.from.id).run();
  return answer(env, query.id, result.meta.changes ? `Голос прийнято: ${options[option]}` : 'Голос уже подано іншим мешканцем вашої квартири або голосування завершено.');
}
export async function pollResults(env: Env, id: number, close: boolean) {
  const poll = await env.HOME_DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first<Poll>();
  if (!poll || poll.status === 'draft') return send(env, env.ADMIN_TELEGRAM_USER_ID, 'Голосування не знайдено або ще не опубліковано.');
  // Close first so subsequent votes cannot change the final tally.
  if (close) await env.HOME_DB.prepare("UPDATE polls SET status='closed' WHERE id=?").bind(id).run();
  const { results } = await env.HOME_DB.prepare('SELECT option_index, COUNT(*) AS count FROM votes WHERE poll_id=? GROUP BY option_index').bind(id).all<{ option_index: number; count: number }>();
  const counts = new Map(results.map(r => [r.option_index, r.count]));
  const options = JSON.parse(poll.options) as string[];
  const total = results.reduce((sum, r) => sum + r.count, 0);
  const text = `Голосування №${id}${close || poll.status === 'closed' ? ' завершено' : ''}\n\n${poll.question}\n\n${options.map((o, i) => `${o}: ${counts.get(i) || 0}`).join('\n')}\n\nПроголосувало квартир: ${total}`;
  if (close && poll.message_id && isConnected(await getGroup(env, poll.chat_id))) {
    await telegram(env, 'editMessageText', { chat_id: poll.chat_id, message_id: poll.message_id, text, reply_markup: { inline_keyboard: [] } });
  }
  return send(env, env.ADMIN_TELEGRAM_USER_ID, text);
}
