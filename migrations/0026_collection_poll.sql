ALTER TABLE house_collections ADD COLUMN vote_poll_id INTEGER REFERENCES polls(id) ON DELETE SET NULL;
ALTER TABLE house_collections ADD COLUMN vote_option_index INTEGER;
CREATE UNIQUE INDEX collection_vote_poll ON house_collections(vote_poll_id) WHERE vote_poll_id IS NOT NULL;
