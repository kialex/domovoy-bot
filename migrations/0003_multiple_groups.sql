CREATE TABLE groups (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','disconnected','removed')),
  bot_present INTEGER NOT NULL DEFAULT 1,
  added_by INTEGER NOT NULL,
  version INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL
);
-- Keep old poll history, but require explicit connection for future publishing.
INSERT INTO groups(chat_id,title,status,bot_present,added_by,version,last_event_id)
SELECT DISTINCT chat_id, CAST(chat_id AS TEXT), 'disconnected', 0, created_by, 0, 0 FROM polls GROUP BY chat_id;

CREATE TABLE residents_scoped (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  apartment TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','tenant')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  PRIMARY KEY(user_id,chat_id)
);
-- The previous release supported one fixed group. Infer it only if unambiguous.
-- Otherwise preserve old records under chat_id=0; they confer no group access.
INSERT INTO residents_scoped
SELECT user_id,
  CASE WHEN (SELECT COUNT(DISTINCT chat_id) FROM polls)=1 THEN (SELECT MIN(chat_id) FROM polls) ELSE 0 END,
  name,apartment,role,status,created_at,reviewed_by,reviewed_at FROM residents;
CREATE TABLE votes_scoped (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  apartment TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL CHECK(option_index>=0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(poll_id,apartment)
);
INSERT INTO votes_scoped SELECT * FROM votes;
DROP TABLE votes;
DROP TABLE residents;
ALTER TABLE residents_scoped RENAME TO residents;
ALTER TABLE votes_scoped RENAME TO votes;
CREATE INDEX residents_status ON residents(chat_id,status);
ALTER TABLE sessions ADD COLUMN chat_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN token TEXT NOT NULL DEFAULT '';
ALTER TABLE residents ADD COLUMN application_token TEXT NOT NULL DEFAULT '';
UPDATE residents SET application_token=lower(hex(randomblob(4)));
ALTER TABLE poll_drafts ADD COLUMN chat_id INTEGER;
ALTER TABLE poll_drafts ADD COLUMN group_version INTEGER;
-- Existing open polls remain in history but must not accept votes before reconnection.
UPDATE polls SET status='closed' WHERE status='open';
