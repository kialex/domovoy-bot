CREATE TABLE mono_connections (
 id TEXT PRIMARY KEY, token_fingerprint TEXT NOT NULL UNIQUE, token_cipher TEXT NOT NULL, jars TEXT NOT NULL,
 last_request_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mono_setup (
 user_id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, step TEXT NOT NULL,
 connection_id TEXT REFERENCES mono_connections(id), jar_id TEXT, chat_id INTEGER,
 deposits INTEGER NOT NULL DEFAULT 1, daily INTEGER NOT NULL DEFAULT 0, goal_notice INTEGER NOT NULL DEFAULT 1,
 expires_at INTEGER NOT NULL
);
CREATE TABLE mono_funds (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mono_connections(id),
 jar_id TEXT NOT NULL, chat_id INTEGER NOT NULL, group_version INTEGER NOT NULL,
 title TEXT NOT NULL, balance INTEGER NOT NULL, goal INTEGER NOT NULL DEFAULT 0,
 deposits INTEGER NOT NULL, daily INTEGER NOT NULL, goal_notice INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
 goal_sent INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 UNIQUE(connection_id,jar_id)
);
CREATE TABLE mono_operations (
 fund_id TEXT NOT NULL REFERENCES mono_funds(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, time INTEGER NOT NULL, amount INTEGER NOT NULL,
 PRIMARY KEY(fund_id,operation_id)
);
CREATE TABLE mono_outbox (
 id INTEGER PRIMARY KEY, fund_id TEXT NOT NULL REFERENCES mono_funds(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER,
 lease_until INTEGER NOT NULL DEFAULT 0, UNIQUE(fund_id,event_key)
);
