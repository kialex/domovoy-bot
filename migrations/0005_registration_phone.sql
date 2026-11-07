ALTER TABLE residents ADD COLUMN phone TEXT NOT NULL DEFAULT '';
CREATE TABLE registration_sessions_phone (
  user_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL CHECK(step IN ('name','apartment','phone','role','review')),
  name TEXT,
  apartment TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  chat_id INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL DEFAULT '',
  role TEXT CHECK(role IN ('owner','tenant')),
  phone TEXT
);
INSERT INTO registration_sessions_phone(user_id,step,name,apartment,updated_at,chat_id,token,role)
SELECT user_id,CASE WHEN step IN ('role','review') THEN 'phone' ELSE step END,name,apartment,updated_at,chat_id,token,role FROM sessions;
DROP TABLE sessions;
ALTER TABLE registration_sessions_phone RENAME TO sessions;
