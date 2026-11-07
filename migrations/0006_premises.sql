CREATE TABLE profiles (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO profiles(user_id,name,phone)
SELECT r.user_id,r.name,r.phone FROM residents r WHERE r.rowid=(SELECT MAX(x.rowid) FROM residents x WHERE x.user_id=r.user_id);
CREATE TABLE premises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('apartment','commercial')),
  number TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  entrance INTEGER CHECK(entrance BETWEEN 1 AND 3),
  floor INTEGER,
  number_start INTEGER NOT NULL,
  number_end INTEGER NOT NULL,
  UNIQUE(chat_id,kind,number)
);
INSERT INTO premises(chat_id,kind,number,number_start,number_end,entrance)
SELECT chat_id,'apartment',apartment,CAST(apartment AS INTEGER),CAST(apartment AS INTEGER),
  CASE WHEN CAST(apartment AS INTEGER) BETWEEN 1 AND 84 THEN 1 WHEN CAST(apartment AS INTEGER) BETWEEN 85 AND 133 THEN 2 WHEN CAST(apartment AS INTEGER) BETWEEN 134 AND 187 THEN 3 ELSE NULL END
FROM (SELECT chat_id,apartment FROM residents UNION SELECT p.chat_id,v.apartment FROM votes v JOIN polls p ON p.id=v.poll_id) GROUP BY chat_id,apartment;
CREATE TABLE memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES profiles(user_id),
  premise_id INTEGER NOT NULL REFERENCES premises(id),
  role TEXT NOT NULL CHECK(role IN ('owner','tenant')),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
  application_token TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  UNIQUE(user_id,premise_id)
);
INSERT INTO memberships(user_id,premise_id,role,status,application_token,created_at,reviewed_by,reviewed_at)
SELECT r.user_id,p.id,r.role,r.status,r.application_token,r.created_at,r.reviewed_by,r.reviewed_at FROM residents r JOIN premises p ON p.chat_id=r.chat_id AND p.kind='apartment' AND p.number=r.apartment;
CREATE INDEX memberships_access ON memberships(user_id,status,premise_id);
CREATE TABLE premise_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  premise_id INTEGER NOT NULL REFERENCES premises(id),
  user_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL CHECK(option_index>=0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(poll_id,premise_id)
);
INSERT INTO premise_votes SELECT v.poll_id,p.id,v.user_id,v.option_index,v.updated_at FROM votes v JOIN polls poll ON poll.id=v.poll_id JOIN premises p ON p.chat_id=poll.chat_id AND p.number=v.apartment AND p.kind='apartment';
CREATE TABLE vote_intents (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  option_index INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  bulk_ids TEXT,
  UNIQUE(user_id,poll_id)
);
CREATE TABLE membership_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Preserve old in-progress forms for inspection; new forms have property-specific fields.
ALTER TABLE sessions RENAME TO legacy_registration_sessions;
CREATE TABLE sessions (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  step TEXT NOT NULL CHECK(step IN ('kind','number','business_name','entrance','floor','name','phone','role','review')),
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
