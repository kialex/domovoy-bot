CREATE TABLE group_vote_requests (
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 chat_id INTEGER NOT NULL,
 group_version INTEGER NOT NULL,
 message_id INTEGER NOT NULL,
 thread_id INTEGER,
 expires_at INTEGER NOT NULL
);
CREATE INDEX group_vote_requests_expiry ON group_vote_requests(expires_at);
