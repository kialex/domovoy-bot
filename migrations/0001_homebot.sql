PRAGMA foreign_keys = ON;
CREATE TABLE residents (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  apartment TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'tenant')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by INTEGER,
  reviewed_at INTEGER
);
CREATE TABLE sessions (
  user_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL CHECK(step IN ('name', 'apartment', 'role')),
  name TEXT,
  apartment TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_update_id INTEGER NOT NULL UNIQUE,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'open', 'closed')),
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  apartment TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES residents(user_id),
  option_index INTEGER NOT NULL CHECK(option_index >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (poll_id, apartment)
);
CREATE TABLE updates (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('processing', 'done')),
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX residents_status ON residents(status);
