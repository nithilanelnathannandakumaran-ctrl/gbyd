-- GetBetterYouDumbo database schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  username           TEXT PRIMARY KEY,
  password_hash      TEXT NOT NULL,
  salt               TEXT NOT NULL,
  is_admin           INTEGER NOT NULL DEFAULT 0,
  kicked             INTEGER NOT NULL DEFAULT 0,
  avatar             TEXT NOT NULL DEFAULT '🎓',
  points             INTEGER NOT NULL DEFAULT 0,
  unlocked_avatars   TEXT NOT NULL DEFAULT '["🎓"]',
  friends            TEXT NOT NULL DEFAULT '[]',
  progress           TEXT NOT NULL DEFAULT '{}',
  badges             TEXT NOT NULL DEFAULT '[]',
  bonus_badges       TEXT NOT NULL DEFAULT '[]',
  had_perfect_round  INTEGER NOT NULL DEFAULT 0,
  force_logout_at    INTEGER NOT NULL DEFAULT 0,
  joined_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  avatar      TEXT,
  category    TEXT,
  message     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  convo_key   TEXT NOT NULL,
  from_user   TEXT NOT NULL,
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(convo_key);
