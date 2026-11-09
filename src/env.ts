export interface Env {
  HOME_DB: D1Database;
  AI?: Pick<Ai,'run'>;
  MONOBANK_ENCRYPTION_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TELEGRAM_USER_ID: string;
}
export interface User { id: number; is_bot?: boolean; username?: string }
export interface Message {
  message_id: number;
  chat: { id: number; type: string };
  from?: User;
  text?: string;
  entities?: {type:string;offset:number;length:number;user?:User;url?:string}[];
  reply_to_message?: Message;
  message_thread_id?: number;
}
export interface Callback { id: string; from: User; data?: string; message?: Message }
export interface ChatMemberUpdate {
  chat: { id: number; type: string; title?: string };
  from: User;
  old_chat_member: { status: string; is_member?: boolean };
  new_chat_member: { status: string; is_member?: boolean };
}
export interface ChatJoinRequest { chat: {id:number;type:string;title?:string}; from:User; user_chat_id:number; date:number }
export interface Update { chat_join_request?: ChatJoinRequest; update_id: number; message?: Message; callback_query?: Callback; my_chat_member?: ChatMemberUpdate }
export type Button = { text: string; callback_data?: string; url?: string };
