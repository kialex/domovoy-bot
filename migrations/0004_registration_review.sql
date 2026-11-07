CREATE TABLE registration_sessions (
  user_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL CHECK(step IN ('name','apartment','role','review')),
  name TEXT,
  apartment TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  chat_id INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL DEFAULT '',
  role TEXT CHECK(role IN ('owner','tenant'))
);
INSERT INTO registration_sessions(user_id,step,name,apartment,updated_at,chat_id,token)
SELECT user_id,step,name,apartment,updated_at,chat_id,token FROM sessions;
DROP TABLE sessions;
ALTER TABLE registration_sessions RENAME TO sessions;
