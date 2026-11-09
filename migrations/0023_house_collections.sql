CREATE TABLE house_collections (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES groups(chat_id),
  title TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
  mono_fund_id TEXT UNIQUE REFERENCES mono_funds(id) ON DELETE SET NULL,
  bank_linked_at INTEGER,
  description TEXT NOT NULL DEFAULT '',
  requested_amount INTEGER,
  bank_card TEXT,
  bank_url TEXT,
  message_id INTEGER,
  published_hash TEXT,
  repost_interval INTEGER NOT NULL DEFAULT 0,
  next_repost_at INTEGER,
  publish_lease_until INTEGER NOT NULL DEFAULT 0,
  previous_message_id INTEGER
);

CREATE TABLE collection_totals (
  collection_id INTEGER NOT NULL REFERENCES house_collections(id),
  profile_id INTEGER REFERENCES profiles(id),
  premise_id INTEGER REFERENCES premises(id),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
  CHECK((profile_id IS NULL) != (premise_id IS NULL))
);
CREATE UNIQUE INDEX collection_resident_total ON collection_totals(collection_id,profile_id);
CREATE UNIQUE INDEX collection_premise_total ON collection_totals(collection_id,premise_id);

ALTER TABLE mono_operations ADD COLUMN collection_id INTEGER REFERENCES house_collections(id);
ALTER TABLE mono_operations ADD COLUMN credited_premise_id INTEGER REFERENCES premises(id);
ALTER TABLE mono_operations ADD COLUMN collection_comment TEXT;
ALTER TABLE mono_operations ADD COLUMN credited_profile_id INTEGER REFERENCES profiles(id);
