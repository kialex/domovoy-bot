ALTER TABLE polls ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 0 CHECK(duration_days IN (0,1,3,5,6,7,14));
ALTER TABLE polls ADD COLUMN ends_at INTEGER;
ALTER TABLE polls ADD COLUMN closed_at INTEGER;
ALTER TABLE polls ADD COLUMN result_message_id INTEGER;
ALTER TABLE polls ADD COLUMN last_countdown_at INTEGER NOT NULL DEFAULT 0;
-- Existing completed polls already have an outcome card; do not repost their history.
UPDATE polls SET result_message_id=message_id,closed_at=created_at WHERE status='closed';
CREATE INDEX polls_end_due ON polls(status,ends_at);
CREATE TABLE poll_drafts_deadlines (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  source_update_id INTEGER NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('question','options','duration','interval','preview','published')),
  question TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  chat_id INTEGER,
  group_version INTEGER,
  repost_interval INTEGER CHECK(repost_interval IN (0,3600,10800,21600,43200,86400)),
  duration_days INTEGER CHECK(duration_days IN (0,1,3,5,6,7,14))
);
INSERT INTO poll_drafts_deadlines(user_id,token,source_update_id,step,question,options,chat_id,group_version,repost_interval,duration_days)
SELECT user_id,token,source_update_id,step,question,options,chat_id,group_version,repost_interval,CASE WHEN step='published' THEN 0 ELSE NULL END FROM poll_drafts;
DROP TABLE poll_drafts;
ALTER TABLE poll_drafts_deadlines RENAME TO poll_drafts;
