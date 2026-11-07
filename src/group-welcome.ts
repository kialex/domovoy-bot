import type { Env } from './env.ts';
import { botStartUrl, sendHtml } from './telegram.ts';

export async function publishGroupWelcome(env:Env,chatId:number,version:number) {
 const claimed=await env.HOME_DB.prepare(`UPDATE group_welcomes SET lease_until=unixepoch()+120
  WHERE chat_id=? AND connection_version=? AND message_id IS NULL AND (lease_until IS NULL OR lease_until<unixepoch())
  AND EXISTS(SELECT 1 FROM groups g WHERE g.chat_id=group_welcomes.chat_id AND g.version=group_welcomes.connection_version AND g.status='approved' AND g.bot_present=1)`).bind(chatId,version).run();
 if(!claimed.meta.changes)return;
 try{
  const url=await botStartUrl(env,`group_${Math.abs(chatId)}`);
  const result=await sendHtml(env,chatId,`🏡 <b>Вітаємо, сусіди! Я HomeBot — помічник нашого будинку.</b>\n\nДопомагатиму проводити голосування, вести облік мешканців квартир і комерційних приміщень та підтримувати актуальні контактні дані.\n\n<b>Для початку пройдіть коротку реєстрацію.</b> Вона прив’яже вас до вашого приміщення та відкриє доступ до голосувань.\n\nГолосувати зможуть лише зареєстровані мешканці. <b>Одне приміщення — один голос</b>, навіть якщо в ньому зареєстровано кілька людей. Так ми уникнемо дублювання голосів.\n\nАнкета заповнюється в особистому чаті зі мною. Телефон бачить лише адміністратор. Для тих, хто вже в групі, реєстрація підтверджується автоматично.`,[[{text:'🏠 Пройти реєстрацію',url}]]);
  await env.HOME_DB.prepare('UPDATE group_welcomes SET message_id=? WHERE chat_id=? AND connection_version=?').bind(result.message_id,chatId,version).run();
 }catch{console.error('Group welcome deferred');}
 finally{await env.HOME_DB.prepare('UPDATE group_welcomes SET lease_until=NULL WHERE chat_id=? AND connection_version=?').bind(chatId,version).run();}
}
export async function retryGroupWelcomes(env:Env) {
 const {results}=await env.HOME_DB.prepare(`SELECT w.chat_id,w.connection_version FROM group_welcomes w JOIN groups g ON g.chat_id=w.chat_id AND g.version=w.connection_version WHERE w.message_id IS NULL AND g.status='approved' AND g.bot_present=1 ORDER BY w.connection_version LIMIT 1`).all<{chat_id:number;connection_version:number}>();
 for(const row of results)await publishGroupWelcome(env,row.chat_id,row.connection_version);
}
