import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('folder','session')),
  name         TEXT NOT NULL,
  position     REAL NOT NULL,
  session_name TEXT,
  panes        INTEGER,
  workdir      TEXT,
  resume_sid   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nodes_parent_idx ON nodes(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_session_name_idx
  ON nodes(session_name) WHERE session_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_usage (
  session_name TEXT PRIMARY KEY,
  opened_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS session_usage_opened_idx ON session_usage(opened_at DESC);

CREATE TABLE IF NOT EXISTS session_origins (
  session_name        TEXT PRIMARY KEY,
  original_created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS session_origins_created_idx
  ON session_origins(original_created_at DESC);

CREATE TABLE IF NOT EXISTS file_transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_name TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('upload','download')),
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS file_transfers_session_created_idx
  ON file_transfers(session_name, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  ip     TEXT NOT NULL,
  ok     INTEGER NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_ts_idx ON login_attempts(ip, ts);

CREATE TABLE IF NOT EXISTS lockouts (
  ip      TEXT PRIMARY KEY,
  until   INTEGER NOT NULL,
  strikes INTEGER NOT NULL
);
`;

let db;

export function openDb() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(path.join(config.dataDir, 'maxclaude-web.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('recent_limit', '5');
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not open');
  return db;
}

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
