import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH, DEFAULT_BEARER } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS people (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'person',   -- person | pet
  relationship TEXT DEFAULT '',
  traits       TEXT DEFAULT '',
  interests    TEXT DEFAULT '',
  birthday     TEXT DEFAULT '',                  -- MM-DD or YYYY-MM-DD
  notes        TEXT DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS context_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  category  TEXT NOT NULL DEFAULT 'fact',        -- city | team | tradition | fact | other
  label     TEXT DEFAULT '',
  value     TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  tz                    TEXT NOT NULL DEFAULT 'America/Toronto',
  default_font          TEXT NOT NULL DEFAULT 'INTER',     -- INTER | PLAYFAIR
  model                 TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  poem_tone             TEXT NOT NULL DEFAULT 'warm, concrete, a little playful',
  poem_rhyme            INTEGER NOT NULL DEFAULT 1,
  poem_time_style       TEXT NOT NULL DEFAULT 'rhyme',       -- start | rhyme (where the clock time sits)
  provider              TEXT NOT NULL DEFAULT 'claude_cli',  -- claude_cli | anthropic | openai
  api_key               TEXT DEFAULT '',
  api_base_url          TEXT DEFAULT '',
  device_hostname       TEXT DEFAULT '',                     -- override shown to enter on the device
  quiet_enabled         INTEGER NOT NULL DEFAULT 0,
  quiet_start           TEXT NOT NULL DEFAULT '00:00',     -- HH:MM local
  quiet_end             TEXT NOT NULL DEFAULT '07:00',
  bearer_token          TEXT NOT NULL DEFAULT '${DEFAULT_BEARER}',
  site_name             TEXT NOT NULL DEFAULT 'Home/1',
  weather_enabled       INTEGER NOT NULL DEFAULT 1,
  weather_units         TEXT NOT NULL DEFAULT 'C',          -- C | F
  weather_lat           REAL,
  weather_lon           REAL,
  weather_place         TEXT DEFAULT '',                    -- resolved place name
  news_enabled          INTEGER NOT NULL DEFAULT 1,
  news_good_only        INTEGER NOT NULL DEFAULT 1,
  news_interval_minutes INTEGER NOT NULL DEFAULT 150,
  news_topics           TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS current_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL DEFAULT 'general',    -- team | city | general
  headline   TEXT NOT NULL,
  summary    TEXT DEFAULT '',
  sentiment  TEXT DEFAULT 'positive',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
  screen_id  TEXT PRIMARY KEY,
  build_id   TEXT DEFAULT '',
  last_seen  TEXT,
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_claimed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poems (
  poem_id         TEXT PRIMARY KEY,
  time24          TEXT NOT NULL,
  text            TEXT NOT NULL,
  model           TEXT DEFAULT '',
  source          TEXT DEFAULT 'claude',   -- claude | fallback
  context_version INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  liked           INTEGER NOT NULL DEFAULT 0,
  screen_id       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notes (
  note_id    TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  posted     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
`);

// Lightweight migrations: add columns that may be missing on older databases.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true; // newly added
  }
  return false;
}
ensureColumn('settings', 'poem_rhyme', 'poem_rhyme INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'poem_time_style', "poem_time_style TEXT NOT NULL DEFAULT 'rhyme'");
ensureColumn('settings', 'provider', "provider TEXT NOT NULL DEFAULT 'claude_cli'");
ensureColumn('settings', 'api_key', "api_key TEXT DEFAULT ''");
ensureColumn('settings', 'api_base_url', "api_base_url TEXT DEFAULT ''");
ensureColumn('settings', 'device_hostname', "device_hostname TEXT DEFAULT ''");
// Quiet-hours enable flag; backfill "on" for installs that already had a window.
if (ensureColumn('settings', 'quiet_enabled', "quiet_enabled INTEGER NOT NULL DEFAULT 0")) {
  db.prepare(`UPDATE settings SET quiet_enabled = 1 WHERE quiet_start <> '' AND quiet_end <> ''`).run();
}

// Ensure the singleton settings row exists.
db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();
// Carry the old default name forward to the new brand.
db.prepare(`UPDATE settings SET site_name = 'Home/1' WHERE id = 1 AND site_name = 'Our Poem Clock'`).run();

export function getSettings() {
  return db.prepare(`SELECT * FROM settings WHERE id = 1`).get();
}

export function updateSettings(patch) {
  const current = getSettings();
  const allowed = [
    'tz', 'default_font', 'model', 'poem_tone', 'poem_rhyme', 'poem_time_style', 'provider', 'api_key',
    'api_base_url', 'device_hostname', 'quiet_enabled', 'quiet_start', 'quiet_end',
    'bearer_token', 'site_name', 'weather_enabled', 'weather_units',
    'weather_lat', 'weather_lon', 'weather_place', 'news_enabled',
    'news_good_only', 'news_interval_minutes', 'news_topics',
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return current;
  db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  return getSettings();
}

// Bumped whenever people/context/settings change, so cached poems can be
// regenerated against fresh context.
let _contextVersion = 1;
export function contextVersion() {
  return _contextVersion;
}
export function bumpContextVersion() {
  _contextVersion += 1;
  return _contextVersion;
}
