export interface Env {
  HOME_DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TELEGRAM_USER_ID: string;
}
export interface User { id: number; is_bot?: boolean }
export interface Message {
  message_id: number;
  chat: { id: number; type: string };
  from?: User;
  text?: string;
}
export interface Callback { id: string; from: User; data?: string; message?: Message }
export interface ChatMemberUpdate {
  chat: { id: number; type: string; title?: string };
  from: User;
  old_chat_member: { status: string; is_member?: boolean };
  new_chat_member: { status: string; is_member?: boolean };
}
export interface Update { update_id: number; message?: Message; callback_query?: Callback; my_chat_member?: ChatMemberUpdate }
export type Button = { text: string; callback_data?: string; url?: string };
