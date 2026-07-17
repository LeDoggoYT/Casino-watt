import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS balances (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 1000 CHECK (amount >= 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_stats (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rounds_played INTEGER NOT NULL DEFAULT 0 CHECK (rounds_played >= 0),
    wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
    losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
    pushes INTEGER NOT NULL DEFAULT 0 CHECK (pushes >= 0),
    blackjacks INTEGER NOT NULL DEFAULT 0 CHECK (blackjacks >= 0),
    highest_balance REAL NOT NULL DEFAULT 1000 CHECK (highest_balance >= 0),
    biggest_win REAL NOT NULL DEFAULT 0 CHECK (biggest_win >= 0),
    total_won REAL NOT NULL DEFAULT 0 CHECK (total_won >= 0),
    total_lost REAL NOT NULL DEFAULT 0 CHECK (total_lost >= 0),
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_win_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_win_streak >= 0),
    total_play_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_play_seconds >= 0)
  );

  CREATE TABLE IF NOT EXISTS active_rounds (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bet REAL NOT NULL CHECK (bet > 0),
    deck_json TEXT NOT NULL,
    player_cards_json TEXT NOT NULL,
    dealer_cards_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS completed_rounds (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bet REAL NOT NULL CHECK (bet > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'push', 'blackjack')),
    player_cards_json TEXT NOT NULL,
    dealer_cards_json TEXT NOT NULL,
    balance_before REAL NOT NULL CHECK (balance_before >= 0),
    balance_after REAL NOT NULL CHECK (balance_after >= 0),
    net_result REAL NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0)
  );

  CREATE TABLE IF NOT EXISTS action_requests (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, action_id)
  );

  CREATE TABLE IF NOT EXISTS activity_sessions (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    last_ping_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    accrued_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accrued_seconds >= 0)
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username_normalized);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_balances_leaderboard ON balances(amount DESC, user_id ASC);
  CREATE INDEX IF NOT EXISTS idx_completed_user_date ON completed_rounds(user_id, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_action_requests_created ON action_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC);
`);

// Kleine, wiederholbar ausführbare Migrationen für bereits vorhandene Datenbanken.
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
if (!userColumns.has("is_suspended")) {
  db.exec("ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0, 1))");
}
if (!userColumns.has("suspension_reason")) {
  db.exec("ALTER TABLE users ADD COLUMN suspension_reason TEXT");
}
if (!userColumns.has("suspended_at")) {
  db.exec("ALTER TABLE users ADD COLUMN suspended_at TEXT");
}

export function nowIso() {
  return new Date().toISOString();
}

export function cleanupExpiredData() {
  const now = nowIso();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM action_requests WHERE julianday(created_at) < julianday('now', '-2 days')").run();
}
