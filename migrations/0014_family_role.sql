CREATE TABLE memberships_family (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES profiles(user_id),
  premise_id INTEGER NOT NULL REFERENCES premises(id),
  role TEXT NOT NULL CHECK(role IN ('owner','tenant','family')),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
  application_token TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  UNIQUE(user_id,premise_id)
);
INSERT INTO memberships_family SELECT * FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_family RENAME TO memberships;
CREATE INDEX memberships_access ON memberships(user_id,status,premise_id);
