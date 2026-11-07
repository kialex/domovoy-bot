CREATE TABLE private_chats (
 user_id INTEGER PRIMARY KEY,
 chat_id INTEGER NOT NULL
);
CREATE TABLE join_requests (
 chat_id INTEGER NOT NULL REFERENCES groups(chat_id),
 user_id INTEGER NOT NULL,
 token TEXT NOT NULL UNIQUE,
 request_date INTEGER NOT NULL,
 update_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 decision TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0,
 notified INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(chat_id,user_id)
);
