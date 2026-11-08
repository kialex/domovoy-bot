-- Contacts imported by the administrator, before a Telegram account is linked.
-- Preserve legacy duplicates, while preventing any new duplicate phone owner.
CREATE TRIGGER profiles_phone_insert BEFORE INSERT ON profiles
WHEN EXISTS (SELECT 1 FROM profiles WHERE phone=NEW.phone AND user_id!=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'phone_already_linked'); END;
CREATE TRIGGER profiles_phone_update BEFORE UPDATE OF phone ON profiles
WHEN EXISTS (SELECT 1 FROM profiles WHERE phone=NEW.phone AND user_id!=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'phone_already_linked'); END;
CREATE TABLE imported_residents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  premise_id INTEGER NOT NULL REFERENCES premises(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','tenant','family')),
  claimed_by INTEGER REFERENCES profiles(user_id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  claimed_at INTEGER,
  UNIQUE(phone,premise_id)
);
CREATE INDEX imported_residents_phone ON imported_residents(phone,claimed_by);
CREATE VIEW directory_members AS
SELECT m.id,m.premise_id,m.user_id,m.role,m.status,u.name,u.phone,u.telegram_username
FROM memberships m JOIN profiles u ON u.user_id=m.user_id WHERE m.status IN ('approved','pending')
UNION ALL
SELECT -r.id,r.premise_id,NULL,r.role,'unconfirmed',r.name,r.phone,''
FROM imported_residents r WHERE r.claimed_by IS NULL;
