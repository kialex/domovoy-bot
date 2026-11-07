CREATE TABLE poll_delete_confirmations (
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 UNIQUE(user_id,poll_id)
);
