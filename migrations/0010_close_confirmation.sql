CREATE TABLE poll_close_confirmations (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  expires_at INTEGER NOT NULL,
  UNIQUE(user_id,poll_id)
);
