import type { Button, Env } from './env.ts';

export async function telegram<T = unknown>(env: Env, method: string, body: object): Promise<T> {
  // Never include the token, request body or Telegram description in logs/errors.
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error(`Telegram ${method}: network failure`); }
  const data = await response.json() as { ok: boolean; result: T; description?: string };
  // Repeated close/retry may render exactly the same final message.
  if (method === 'editMessageText' && response.status === 400 &&
      data.description?.includes('message is not modified')) return data.result;
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: rejected (${response.status})`);
  return data.result;
}
export function send(env: Env, chatId: number | string, text: string, buttons?: Button[][]) {
  return telegram<{ message_id: number }>(env, 'sendMessage', {
    chat_id: chatId, text,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}
export function answer(env: Env, id: string, text: string, url?: string) {
  return telegram(env, 'answerCallbackQuery', {
    callback_query_id: id, text, cache_time: 0,
    ...(url ? { url } : { show_alert: true }),
  });
}
export async function registrationUrl(env: Env, pollId?: number) {
  const bot = await telegram<{ username?: string }>(env, 'getMe', {});
  if (!bot.username || !/^[a-zA-Z0-9_]{5,32}$/.test(bot.username)) {
    throw new Error('Telegram getMe: missing or invalid bot username');
  }
  return `https://t.me/${bot.username}?start=${pollId ? `poll_${pollId}` : 'register'}`;
}
