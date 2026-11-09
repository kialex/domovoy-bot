ALTER TABLE groups ADD COLUMN city_notices_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE city_notices (
  chat_id INTEGER NOT NULL,
  notice_id INTEGER NOT NULL,
  message_id INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, notice_id)
);
