-- Reuse existing connections and funds; no event queue or new tables.
ALTER TABLE mono_connections ADD COLUMN webhook_url TEXT NOT NULL DEFAULT '';
ALTER TABLE mono_connections ADD COLUMN webhook_attempted_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mono_connections ADD COLUMN webhook_registered_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mono_funds ADD COLUMN balance_updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE mono_funds SET balance_updated_at=checked_at;
