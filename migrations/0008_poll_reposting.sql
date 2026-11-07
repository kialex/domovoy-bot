ALTER TABLE polls ADD COLUMN repost_interval INTEGER NOT NULL DEFAULT 0 CHECK(repost_interval IN (0,3600,10800,21600,43200,86400));
ALTER TABLE polls ADD COLUMN next_repost_at INTEGER;
ALTER TABLE polls ADD COLUMN published_at INTEGER;
ALTER TABLE polls ADD COLUMN repost_lease TEXT;
ALTER TABLE polls ADD COLUMN repost_lease_until INTEGER;
ALTER TABLE polls ADD COLUMN last_repost_key TEXT;
UPDATE polls SET published_at=created_at WHERE message_id IS NOT NULL;
CREATE INDEX polls_repost_due ON polls(status,next_repost_at);
CREATE TABLE poll_message_cleanup (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  redirected_to INTEGER,
  PRIMARY KEY(poll_id,message_id)
);
CREATE TABLE poll_drafts_reposting (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  source_update_id INTEGER NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('question','options','interval','preview','published')),
  question TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  chat_id INTEGER,
  group_version INTEGER,
  repost_interval INTEGER CHECK(repost_interval IN (0,3600,10800,21600,43200,86400))
);
INSERT INTO poll_drafts_reposting(user_id,token,source_update_id,step,question,options,chat_id,group_version,repost_interval)
SELECT user_id,token,source_update_id,step,question,options,chat_id,group_version,CASE WHEN step='published' THEN 0 ELSE NULL END FROM poll_drafts;
DROP TABLE poll_drafts;
ALTER TABLE poll_drafts_reposting RENAME TO poll_drafts;

CREATE TABLE poll_repost_runs (
  request_key TEXT PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  new_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
