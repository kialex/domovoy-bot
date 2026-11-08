import type { Button, Env } from './env.ts';
import { telegram } from './telegram.ts';
export interface PollView {text:string;buttons:Button[][];rich_message:{html:string}}
export async function sendPollView(env:Env,chatId:number,view:PollView){
 return telegram<{message_id:number}>(env,'sendRichMessage',{chat_id:chatId,rich_message:view.rich_message});
}
export async function editPollView(env:Env,chatId:number,messageId:number,view:PollView){
 // Clear legacy inline keyboards: live voting controls now live inside rich text.
 return telegram(env,'editMessageText',{chat_id:chatId,message_id:messageId,rich_message:view.rich_message,reply_markup:{inline_keyboard:[]}});
}
