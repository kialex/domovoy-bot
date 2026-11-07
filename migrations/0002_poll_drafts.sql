CREATE TABLE poll_drafts (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  source_update_id INTEGER NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('question', 'options', 'preview', 'published')),
  question TEXT,
  options TEXT NOT NULL DEFAULT '[]'
);
