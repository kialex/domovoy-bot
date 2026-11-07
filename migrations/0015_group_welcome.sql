CREATE TABLE group_welcomes (
 chat_id INTEGER NOT NULL REFERENCES groups(chat_id),
 connection_version INTEGER NOT NULL,
 message_id INTEGER,
 lease_until INTEGER,
 PRIMARY KEY(chat_id,connection_version)
);
