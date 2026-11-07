ALTER TABLE polls ADD COLUMN description TEXT NOT NULL DEFAULT '';
CREATE TABLE poll_drafts_description (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  source_update_id INTEGER NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('question','description','options','duration','interval','preview','published')),
  question TEXT,
  description TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  chat_id INTEGER,
  group_version INTEGER,
  repost_interval INTEGER CHECK(repost_interval IN (0,3600,10800,21600,43200,86400)),
  duration_days INTEGER CHECK(duration_days IN (0,1,3,5,6,7,14))
);
INSERT INTO poll_drafts_description(user_id,token,source_update_id,step,question,options,chat_id,group_version,repost_interval,duration_days)
SELECT user_id,token,source_update_id,step,question,options,chat_id,group_version,repost_interval,duration_days FROM poll_drafts;
DROP TABLE poll_drafts;
ALTER TABLE poll_drafts_description RENAME TO poll_drafts;
