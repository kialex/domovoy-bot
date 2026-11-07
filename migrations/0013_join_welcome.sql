ALTER TABLE join_requests ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE join_requests ADD COLUMN welcome_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE join_requests ADD COLUMN welcome_lease_until INTEGER;
