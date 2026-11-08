-- Keep registered and not-yet-linked people in the same existing tables.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE profiles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  telegram_username TEXT NOT NULL DEFAULT ''
);
INSERT INTO profiles_new(user_id,name,phone,updated_at,telegram_username)
SELECT user_id,name,phone,updated_at,telegram_username FROM profiles;
INSERT INTO profiles_new(name,phone)
SELECT r.name,r.phone FROM imported_residents r WHERE r.claimed_by IS NULL
AND NOT EXISTS (SELECT 1 FROM profiles_new u WHERE u.phone=r.phone)
GROUP BY r.phone;
CREATE TABLE memberships_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles_new(id),
  user_id INTEGER REFERENCES profiles_new(user_id),
  premise_id INTEGER NOT NULL REFERENCES premises(id),
  role TEXT NOT NULL CHECK(role IN ('owner','tenant','family')),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
  application_token TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  UNIQUE(profile_id,premise_id),
  UNIQUE(user_id,premise_id)
);
INSERT INTO memberships_new
SELECT m.id,u.id,m.user_id,m.premise_id,m.role,m.status,m.application_token,m.details,m.version,m.created_at,m.reviewed_by,m.reviewed_at
FROM memberships m JOIN profiles_new u ON u.user_id=m.user_id;
INSERT INTO memberships_new(profile_id,user_id,premise_id,role,status,application_token)
SELECT u.id,u.user_id,r.premise_id,r.role,'approved',lower(hex(randomblob(16)))
FROM imported_residents r JOIN profiles_new u ON u.phone=r.phone
WHERE r.claimed_by IS NULL
ON CONFLICT(profile_id,premise_id) DO NOTHING;
DROP VIEW directory_members;
DROP TABLE imported_residents;
DROP TABLE memberships;
DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;
ALTER TABLE memberships_new RENAME TO memberships;
CREATE INDEX memberships_access ON memberships(user_id,status,premise_id);
CREATE INDEX profiles_phone ON profiles(phone);
CREATE TRIGGER profiles_phone_insert BEFORE INSERT ON profiles
WHEN EXISTS (SELECT 1 FROM profiles WHERE phone=NEW.phone AND (NEW.user_id IS NULL OR user_id IS NOT NEW.user_id))
BEGIN SELECT RAISE(ABORT,'phone_already_linked'); END;
CREATE TRIGGER profiles_phone_update BEFORE UPDATE OF phone ON profiles
WHEN EXISTS (SELECT 1 FROM profiles WHERE phone=NEW.phone AND id!=NEW.id)
BEGIN SELECT RAISE(ABORT,'phone_already_linked'); END;
