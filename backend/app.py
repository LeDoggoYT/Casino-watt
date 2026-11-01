"""Watt Casino API – Flask/SQLite backend for PythonAnywhere."""
from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
from flask import Flask, g, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,20}$")
ACTION_RE = re.compile(r"^[A-Za-z0-9_-]{16,80}$")
SUITS = ["♠", "♥", "♦", "♣"]
RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]
RATE_BUCKETS: dict[str, list[float]] = {}
CLEANUP_LOCK = threading.Lock()
LAST_CLEANUP_AT = 0.0
AUTH_TOUCH_SECONDS = 5 * 60
CLEANUP_INTERVAL_SECONDS = 15 * 60
MAX_UPGRADE_LEVEL = 5
CHICKEN_MULTIPLIERS = (0.8, 1.0, 2.4, 3.0, 3.8, 4.8, 6.0, 7.5, 9.5)
CHICKEN_SUCCESS_CHANCES = (90, 85, 80, 75, 70, 65, 60, 55, 50)
UPGRADES = {
    "starting_capital": {"name": "Startkapital", "base_cost": 750, "effect": "+250 Chips Neustartkapital je Level"},
    "luck": {"name": "Glück", "base_cost": 1500, "effect": "+2 % Rettungschance je Level"},
    "blackjack_bonus": {"name": "Blackjack-Bonus", "base_cost": 2000, "effect": "+5 % Auszahlung je Level"},
    "loss_protection": {"name": "Verlustschutz", "base_cost": 1250, "effect": "2 % Einsatz zurück je Level"},
    "streak_bonus": {"name": "Serienbonus", "base_cost": 1500, "effect": "+3 % ab dem dritten Sieg je Level"},
    "double_bonus": {"name": "Doppel-Profi", "base_cost": 1750, "effect": "+5 % bei gewonnenem Verdoppeln je Level"},
    "daily_bonus": {"name": "Tagesbonus", "base_cost": 500, "effect": "50 Chips täglich je Level"},
}


class ApiError(Exception):
    def __init__(self, status: int, message: str, data: dict | None = None):
        self.status, self.message, self.data = status, message, data or {}
        super().__init__(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_int(value: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        result = int(value if value is not None else fallback)
    except (TypeError, ValueError):
        raise RuntimeError("Ungültige Server-Konfiguration.")
    if not minimum <= result <= maximum:
        raise RuntimeError("Ungültige Server-Konfiguration.")
    return result


def load_env_file() -> None:
    """Tiny .env reader; PythonAnywhere needs no extra dotenv dependency."""
    file = BASE_DIR / ".env"
    if not file.exists():
        return
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", str(BASE_DIR / "data" / "watt-casino.sqlite"))).expanduser()
if not DATABASE_PATH.is_absolute():
    DATABASE_PATH = (BASE_DIR / DATABASE_PATH).resolve()
AVATAR_DIRECTORY = Path(os.environ.get("AVATAR_DIRECTORY", str(DATABASE_PATH.parent / "avatars"))).expanduser()
if not AVATAR_DIRECTORY.is_absolute():
    AVATAR_DIRECTORY = (BASE_DIR / AVATAR_DIRECTORY).resolve()
FRONTEND_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get(
        "FRONTEND_ORIGINS",
        "https://wigipedia.netlify.app,http://127.0.0.1:5501,http://127.0.0.1:8080,http://localhost:5501,http://localhost:8080",
    ).split(",")
    if origin.strip()
}
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "2011")
if os.environ.get("NODE_ENV") == "production" and not ADMIN_PASSWORD:
    raise RuntimeError("ADMIN_PASSWORD muss gesetzt sein.")
SESSION_DAYS = parse_int(os.environ.get("SESSION_DAYS"), 30, 1, 365)
BCRYPT_ROUNDS = parse_int(os.environ.get("BCRYPT_ROUNDS"), 12, 10, 15)


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(DATABASE_PATH, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        g.db = connection
    return g.db


@contextmanager
def transaction():
    connection = get_db()
    try:
        connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
 is_suspended INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0,1)), suspension_reason TEXT, suspended_at TEXT,
 avatar_filename TEXT);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS balances (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, amount REAL NOT NULL DEFAULT 1000 CHECK (amount >= 0), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS player_stats (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, rounds_played INTEGER NOT NULL DEFAULT 0,
 wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, pushes INTEGER NOT NULL DEFAULT 0,
 blackjacks INTEGER NOT NULL DEFAULT 0, highest_balance REAL NOT NULL DEFAULT 1000,
 biggest_win REAL NOT NULL DEFAULT 0, total_won REAL NOT NULL DEFAULT 0, total_lost REAL NOT NULL DEFAULT 0,
 current_streak INTEGER NOT NULL DEFAULT 0, best_win_streak INTEGER NOT NULL DEFAULT 0, total_play_seconds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS active_rounds (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, bet REAL NOT NULL CHECK (bet > 0),
 deck_json TEXT NOT NULL, player_cards_json TEXT NOT NULL, dealer_cards_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 luck_used INTEGER NOT NULL DEFAULT 0 CHECK (luck_used IN (0,1)), doubled INTEGER NOT NULL DEFAULT 0 CHECK (doubled IN (0,1)));
CREATE TABLE IF NOT EXISTS active_chicken_rounds (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 bet REAL NOT NULL CHECK (bet >= 5), steps INTEGER NOT NULL DEFAULT 0 CHECK (steps BETWEEN 0 AND 10),
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS big_wins (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 game TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS completed_rounds (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, bet REAL NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('win','loss','push','blackjack')), player_cards_json TEXT NOT NULL,
 dealer_cards_json TEXT NOT NULL, balance_before REAL NOT NULL, balance_after REAL NOT NULL, net_result REAL NOT NULL,
 started_at TEXT NOT NULL, completed_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS action_requests (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, action_id TEXT NOT NULL, action_type TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY (user_id, action_id));
CREATE TABLE IF NOT EXISTS activity_sessions (
 session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 started_at TEXT NOT NULL, last_ping_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, accrued_seconds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_upgrades (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, upgrade_key TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL, PRIMARY KEY (user_id, upgrade_key), CHECK (level BETWEEN 0 AND 5));
CREATE TABLE IF NOT EXISTS upgrade_claims (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, last_daily_claim_at TEXT);
CREATE TABLE IF NOT EXISTS admin_sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action TEXT NOT NULL, previous_value TEXT, new_value TEXT, reason TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username_normalized);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_balances_leaderboard ON balances(amount DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS idx_completed_user_date ON completed_rounds(user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_requests_created ON action_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_upgrades_user ON user_upgrades(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC);
"""


def initialise_database(app: Flask) -> None:
    with app.app_context():
        db = get_db()
        db.executescript(SCHEMA)
        # Bestehende Fünf-Spuren-Runden inklusive Einsatz unverändert übernehmen.
        with transaction():
            chicken_schema = db.execute("SELECT sql FROM sqlite_master WHERE name='active_chicken_rounds'").fetchone()["sql"]
            if "BETWEEN 0 AND 5" in chicken_schema:
                db.execute("""CREATE TABLE chicken_rounds_expanded (
                    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    bet REAL NOT NULL CHECK (bet >= 5), steps INTEGER NOT NULL DEFAULT 0 CHECK (steps BETWEEN 0 AND 10),
                    created_at TEXT NOT NULL)""")
                db.execute("INSERT INTO chicken_rounds_expanded SELECT id,user_id,bet,steps,created_at FROM active_chicken_rounds")
                db.execute("DROP TABLE active_chicken_rounds")
                db.execute("ALTER TABLE chicken_rounds_expanded RENAME TO active_chicken_rounds")
        for name, definition in [
            ("is_suspended", "INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0,1))"),
            ("suspension_reason", "TEXT"),
            ("suspended_at", "TEXT"),
            ("avatar_filename", "TEXT"),
        ]:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
            if name not in columns:
                db.execute(f"ALTER TABLE users ADD COLUMN {name} {definition}")
        active_round_columns = {row["name"] for row in db.execute("PRAGMA table_info(active_rounds)")}
        if "luck_used" not in active_round_columns:
            db.execute("ALTER TABLE active_rounds ADD COLUMN luck_used INTEGER NOT NULL DEFAULT 0 CHECK (luck_used IN (0,1))")
        if "doubled" not in active_round_columns:
            db.execute("ALTER TABLE active_rounds ADD COLUMN doubled INTEGER NOT NULL DEFAULT 0 CHECK (doubled IN (0,1))")


def ok(data: dict | None = None, message: str = "", status: int = 200):
    return jsonify(success=True, data=data or {}, message=message), status


def body() -> dict:
    value = request.get_json(silent=True)
    if value is None or not isinstance(value, dict):
        raise ApiError(400, "Ungültiges JSON.")
    return value


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def normalise(username: str) -> str:
    return username.lower()


def positive_int(value: str | None, fallback: int, maximum: int | None = None) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return fallback
    if result < 1:
        return fallback
    return min(result, maximum) if maximum else result


def enforce_rate_limit(scope: str, maximum: int, seconds: int) -> None:
    """Small in-process limiter; PythonAnywhere's single web worker shares it."""
    key = f"{scope}:{request.remote_addr or 'unknown'}"
    now = time.monotonic()
    active = [stamp for stamp in RATE_BUCKETS.get(key, []) if stamp > now - seconds]
    if len(active) >= maximum:
        raise ApiError(429, "Zu viele Anfragen. Bitte kurz warten.")
    active.append(now)
    RATE_BUCKETS[key] = active


def validate_credentials(username, password) -> tuple[str, str]:
    if not isinstance(username, str) or not USERNAME_RE.fullmatch(username):
        raise ApiError(400, "Der Benutzername muss 3–20 Zeichen lang sein und darf Buchstaben, Zahlen, _ und - enthalten.")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ApiError(400, "Das Passwort muss 8–128 Zeichen lang sein.")
    return username, normalise(username)


def restore_empty_balance(user_id):
    # Ein laufender All-in-Einsatz kann vorübergehend null verfügbare Chips lassen.
    # Die Auffüllung erfolgt erst nach dem Abschluss dieser Runde.
    db = get_db()
    db.execute("""UPDATE balances SET amount=1000+250*COALESCE(
                  (SELECT level FROM user_upgrades WHERE user_id=? AND upgrade_key='starting_capital'),0),
                  updated_at=? WHERE user_id=? AND amount=0
                  AND NOT EXISTS (SELECT 1 FROM active_rounds WHERE user_id=?)
                  AND NOT EXISTS (SELECT 1 FROM active_chicken_rounds WHERE user_id=?)""",
               (user_id, utc_now(), user_id, user_id, user_id))
    return db.execute("SELECT amount FROM balances WHERE user_id=?", (user_id,)).fetchone()["amount"]


def auth_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme != "Bearer" or not token or len(token) > 200:
            raise ApiError(401, "Bitte erneut anmelden.")
        db = get_db()
        session = db.execute(
            """SELECT s.id AS session_id,s.user_id,s.expires_at,s.last_used_at,u.username,u.last_activity_at,
                      u.is_suspended,u.suspension_reason,b.amount AS balance
               FROM sessions s JOIN users u ON u.id=s.user_id JOIN balances b ON b.user_id=u.id WHERE s.token_hash=?""",
            (token_hash(token),),
        ).fetchone()
        if not session or session["expires_at"] <= utc_now():
            if session:
                db.execute("DELETE FROM sessions WHERE id=?", (session["session_id"],))
            raise ApiError(401, "Die Sitzung ist abgelaufen. Bitte erneut anmelden.")
        if session["is_suspended"]:
            raise ApiError(403, "Dieses Spielerkonto wurde gesperrt.", {"suspended": True, "reason": session["suspension_reason"] or "Kein Grund angegeben."})
        restore_empty_balance(session["user_id"])
        g.auth = dict(session)
        now = utc_now()
        # SQLite serialisiert Schreibzugriffe. Diese Zeitstempel müssen nicht bei jedem
        # Karten-/Leaderboard-Request geschrieben werden; einmal je fünf Minuten reicht.
        stale_before = (datetime.now(timezone.utc) - timedelta(seconds=AUTH_TOUCH_SECONDS)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        if session["last_used_at"] < stale_before:
            renewed_until = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z")
            db.execute("UPDATE sessions SET last_used_at=?,expires_at=? WHERE id=?",
                       (now, renewed_until, session["session_id"]))
        if session["last_activity_at"] < stale_before:
            db.execute("UPDATE users SET last_activity_at=? WHERE id=?", (now, session["user_id"]))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme != "Bearer" or not token or len(token) > 200:
            raise ApiError(401, "Admin-Anmeldung erforderlich.")
        db = get_db()
        session = db.execute("SELECT * FROM admin_sessions WHERE token_hash=?", (token_hash(token),)).fetchone()
        if not session or session["expires_at"] <= utc_now():
            if session:
                db.execute("DELETE FROM admin_sessions WHERE id=?", (session["id"],))
            raise ApiError(401, "Die Admin-Sitzung ist abgelaufen.")
        g.admin = dict(session)
        stale_before = (datetime.now(timezone.utc) - timedelta(seconds=AUTH_TOUCH_SECONDS)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        if session["last_used_at"] < stale_before:
            db.execute("UPDATE admin_sessions SET last_used_at=? WHERE id=?", (utc_now(), session["id"]))
        return view(*args, **kwargs)
    return wrapped


def create_shoe() -> list[dict]:
    cards = [{"rank": rank, "suit": suit} for _ in range(6) for suit in SUITS for rank in RANKS]
    secrets.SystemRandom().shuffle(cards)
    return cards


def draw(deck: list[dict]) -> dict:
    if not deck:
        raise ApiError(500, "Der Kartenschlitten ist leer.")
    return deck.pop()


def hand_value(cards: list[dict]) -> int:
    total, aces = 0, 0
    for card in cards:
        if card["rank"] == "A":
            total, aces = total + 11, aces + 1
        elif card["rank"] in {"J", "Q", "K"}:
            total += 10
        else:
            total += int(card["rank"])
    while total > 21 and aces:
        total, aces = total - 10, aces - 1
    return total


def blackjack(cards): return len(cards) == 2 and hand_value(cards) == 21


def dealer_play(deck, cards):
    while hand_value(cards) < 17:
        cards.append(draw(deck))


def outcome(player, dealer):
    p, d = hand_value(player), hand_value(dealer)
    if p > 21: return "loss"
    if blackjack(player) and not blackjack(dealer): return "blackjack"
    if blackjack(dealer) and not blackjack(player): return "loss"
    if d > 21 or p > d: return "win"
    if p < d: return "loss"
    return "push"


def outcome_message(result, player, dealer):
    p, d = hand_value(player), hand_value(dealer)
    if result == "blackjack": return "Blackjack! Auszahlung 3 zu 2."
    if result == "push": return f"Gleichstand bei {p} – Einsatz zurück."
    if result == "loss" and p > 21: return f"Mit {p} überkauft – der Dealer gewinnt."
    if result == "loss": return f"{d} schlägt {p} – der Dealer gewinnt."
    if d > 21: return f"Dealer überkauft mit {d} – Sie gewinnen."
    return f"{p} schlägt {d} – Sie gewinnen."


def parse_round(row):
    if not row: return None
    return {"id": row["id"], "userId": row["user_id"], "bet": row["bet"], "deck": json.loads(row["deck_json"]),
            "playerCards": json.loads(row["player_cards_json"]), "dealerCards": json.loads(row["dealer_cards_json"]),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"], "luckUsed": bool(row["luck_used"]),
            "doubled": bool(row["doubled"])}


def load_round(user_id): return parse_round(get_db().execute("SELECT * FROM active_rounds WHERE user_id=?", (user_id,)).fetchone())


def save_round(round_):
    now = utc_now()
    get_db().execute("""UPDATE active_rounds SET bet=?,deck_json=?,player_cards_json=?,dealer_cards_json=?,updated_at=?,luck_used=?,doubled=? WHERE id=? AND user_id=?""",
                     (round_["bet"], json.dumps(round_["deck"]), json.dumps(round_["playerCards"]), json.dumps(round_["dealerCards"]), now,
                      int(round_.get("luckUsed",False)), int(round_.get("doubled",False)), round_["id"], round_["userId"]))
    round_["updatedAt"] = now


def public_round(round_, balance, reveal=False, result=None):
    dealer = round_["dealerCards"] if reveal else [({"hidden": True} if i == 1 else card) for i, card in enumerate(round_["dealerCards"])]
    allowed = [] if result else ["hit", "stand"] + (["double"] if len(round_["playerCards"]) == 2 and balance >= round_["bet"] else [])
    return {"id": round_["id"], "bet": round_["bet"], "playerCards": round_["playerCards"], "dealerCards": dealer,
            "playerValue": hand_value(round_["playerCards"]), "dealerValue": hand_value(round_["dealerCards"] if reveal else [round_["dealerCards"][0]]),
            "dealerRevealed": reveal, "status": "completed" if result else "active", "allowedActions": allowed, "result": result,
            "notice": "Glück hat Sie vor dem Überkaufen gerettet!" if round_.get("luckTriggered") else None,
            "startedAt": round_["createdAt"]}


def upgrade_levels(user_id: int) -> dict[str, int]:
    levels = {key: 0 for key in UPGRADES}
    rows = get_db().execute("SELECT upgrade_key,level FROM user_upgrades WHERE user_id=?", (user_id,)).fetchall()
    for row in rows:
        if row["upgrade_key"] in levels:
            levels[row["upgrade_key"]] = row["level"]
    return levels


def upgrade_price(key: str, level: int) -> int:
    return int(UPGRADES[key]["base_cost"] * (2 ** level))


def daily_bonus_state(user_id: int, levels: dict[str, int] | None = None) -> dict:
    levels = levels or upgrade_levels(user_id)
    level = levels["daily_bonus"]
    row = get_db().execute("SELECT last_daily_claim_at FROM upgrade_claims WHERE user_id=?", (user_id,)).fetchone()
    last_claimed = row["last_daily_claim_at"] if row else None
    next_claim = None
    available = level > 0
    if last_claimed:
        next_dt = datetime.fromisoformat(last_claimed.replace("Z", "+00:00")) + timedelta(hours=24)
        next_claim = next_dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        available = level > 0 and next_dt <= datetime.now(timezone.utc)
    return {"available": available, "amount": level * 50, "lastClaimedAt": last_claimed, "nextClaimAt": next_claim}


def public_upgrades(user_id: int, balance: float) -> dict:
    levels = upgrade_levels(user_id)
    round_active = bool(get_db().execute("SELECT 1 FROM active_rounds WHERE user_id=?", (user_id,)).fetchone())
    entries = []
    for key, config in UPGRADES.items():
        level = levels[key]
        price = upgrade_price(key, level) if level < MAX_UPGRADE_LEVEL else None
        entries.append({"key": key, "name": config["name"], "effect": config["effect"], "level": level,
                        "maxLevel": MAX_UPGRADE_LEVEL, "price": price,
                        "canBuy": not round_active and price is not None and balance >= price})
    return {"upgrades": entries, "dailyBonus": daily_bonus_state(user_id, levels), "balance": balance,
            "roundActive": round_active}


def register_action(user_id, action_id, action_type):
    if not isinstance(action_id, str) or not ACTION_RE.fullmatch(action_id):
        raise ApiError(400, "Für diese Aktion fehlt eine gültige Aktions-ID.")
    try:
        get_db().execute("INSERT INTO action_requests (user_id,action_id,action_type,created_at) VALUES (?,?,?,?)", (user_id, action_id, action_type, utc_now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "Diese Aktion wurde bereits verarbeitet.")


def record_big_win(db, user_id, game, amount, bet):
    if amount > 10000 or amount + bet > 5 * bet:
        db.execute("INSERT INTO big_wins (user_id,game,amount,created_at) VALUES (?,?,?,?)", (user_id, game, amount, utc_now()))
        db.execute("DELETE FROM big_wins WHERE id < (SELECT MAX(id) - 1000 FROM big_wins)")


def settle(round_, result, levels=None):
    db = get_db()
    balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (round_["userId"],)).fetchone()
    if not balance: raise ApiError(404, "Spielerkonto nicht gefunden.")
    levels = levels or upgrade_levels(round_["userId"])
    multiplier = {"blackjack": 2.5, "win": 2, "push": 1, "loss": 0}[result]
    payout = round_["bet"] * multiplier
    if result == "blackjack":
        payout += round_["bet"] * 0.05 * levels["blackjack_bonus"]
    if result == "loss":
        payout += round_["bet"] * 0.02 * levels["loss_protection"]
    stats = db.execute("SELECT * FROM player_stats WHERE user_id=?", (round_["userId"],)).fetchone()
    if result in {"win", "blackjack"} and stats["current_streak"] >= 2:
        payout += round_["bet"] * 0.03 * levels["streak_bonus"]
    if result in {"win", "blackjack"} and round_.get("doubled"):
        payout += round_["bet"] * 0.05 * levels["double_bonus"]
    before = balance["amount"] + round_["bet"]
    raw_after = balance["amount"] + payout
    refill_amount = 1000 + 250 * levels["starting_capital"]
    after, refilled = (refill_amount, True) if balance["amount"] <= 0 and result == "loss" else (raw_after, False)
    after = round(after * 2) / 2
    completed = utc_now()
    duration = max(0, min(86400, int((datetime.fromisoformat(completed.replace("Z","+00:00")) - datetime.fromisoformat(round_["createdAt"].replace("Z","+00:00"))).total_seconds())))
    net = after - before
    if result in {"win", "blackjack"}:
        record_big_win(db, round_["userId"], "Blackjack", round(payout * 2) / 2 - round_["bet"], round_["bet"])
    db.execute("UPDATE balances SET amount=?,updated_at=? WHERE user_id=?", (after, completed, round_["userId"]))
    streak = stats["current_streak"]
    if result in {"win","blackjack"}: streak = streak + 1 if streak > 0 else 1
    elif result == "loss": streak = streak - 1 if streak < 0 else -1
    won = result in {"win","blackjack"}
    db.execute("""UPDATE player_stats SET rounds_played=rounds_played+1,wins=wins+?,losses=losses+?,pushes=pushes+?,blackjacks=blackjacks+?,
       highest_balance=MAX(highest_balance,?),biggest_win=MAX(biggest_win,?),total_won=total_won+?,total_lost=total_lost+?,
       current_streak=?,best_win_streak=MAX(best_win_streak,?) WHERE user_id=?""",
       (int(won), int(result=="loss"), int(result=="push"), int(result=="blackjack"), after, max(0,net), max(0,net), max(0,-net), streak, max(0,streak), round_["userId"]))
    db.execute("""INSERT INTO completed_rounds (id,user_id,bet,outcome,player_cards_json,dealer_cards_json,balance_before,balance_after,net_result,started_at,completed_at,duration_seconds)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", (round_["id"],round_["userId"],round_["bet"],result,json.dumps(round_["playerCards"]),json.dumps(round_["dealerCards"]),before,after,net,round_["createdAt"],completed,duration))
    db.execute("DELETE FROM active_rounds WHERE id=? AND user_id=?", (round_["id"],round_["userId"]))
    refill_text = f"{refill_amount:,.0f}".replace(",", ".")
    refill_message = f" Kontostand automatisch auf {refill_text} Chips erneuert." if refilled else ""
    luck_message = " Glück hat Sie zuvor vor dem Überkaufen gerettet." if round_.get("luckTriggered") else ""
    message = outcome_message(result,round_["playerCards"],round_["dealerCards"]) + luck_message + refill_message
    return {"round": public_round(round_,after,True,{"outcome":result,"payout":payout,"netResult":net,"message":message}),"balance":after}


def rates(row):
    completed = row["rounds_played"] or 0
    return (round((row["wins"] / completed) * 100, 1), round((row["losses"] / completed) * 100, 1)) if completed else (0, 0)


def avatar_url(filename: str | None) -> str | None:
    return f"/api/avatars/{filename}" if filename else None


def image_extension(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return None


def issue_session(user_id):
    token, now = new_token(), datetime.now(timezone.utc)
    expires = now + timedelta(days=SESSION_DAYS)
    get_db().execute("INSERT INTO sessions (user_id,token_hash,created_at,expires_at,last_used_at) VALUES (?,?,?,?,?)",
                     (user_id, token_hash(token), now.isoformat(timespec="milliseconds").replace("+00:00","Z"), expires.isoformat(timespec="milliseconds").replace("+00:00","Z"), now.isoformat(timespec="milliseconds").replace("+00:00","Z")))
    return token, expires.isoformat(timespec="milliseconds").replace("+00:00","Z")


def audit(user_id, action, previous, new, reason=None):
    get_db().execute("INSERT INTO admin_audit_log (target_user_id,action,previous_value,new_value,reason,created_at) VALUES (?,?,?,?,?,?)",
                     (user_id,action,json.dumps(previous) if previous is not None else None,json.dumps(new) if new is not None else None,reason,utc_now()))


def make_app():
    app = Flask(__name__)
    # Multipart-Overhead darf die eigentliche 2-MB-Bildgrenze nicht auslösen.
    app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024
    initialise_database(app)

    @app.teardown_appcontext
    def close_db(_error=None):
        db = g.pop("db", None)
        if db: db.close()

    @app.before_request
    def cors_and_cleanup():
        global LAST_CLEANUP_AT
        if request.method == "OPTIONS":
            return ("", 204)
        if request.path.startswith("/api/"):
            enforce_rate_limit("api", 180, 60)
        if request.path in {"/api/auth/register", "/api/auth/login"}:
            enforce_rate_limit("auth", 20, 15 * 60)
        if request.path == "/api/admin/login":
            enforce_rate_limit("admin-login", 5, 15 * 60)
        # Aufräumen war vorher Teil jeder API-Anfrage und erzeugte damit unnötige
        # SQLite-Schreibsperren. Pro Worker genügt ein Lauf alle 15 Minuten.
        monotonic_now = time.monotonic()
        if monotonic_now - LAST_CLEANUP_AT >= CLEANUP_INTERVAL_SECONDS:
            with CLEANUP_LOCK:
                if monotonic_now - LAST_CLEANUP_AT >= CLEANUP_INTERVAL_SECONDS:
                    now = utc_now()
                    db = get_db()
                    db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
                    db.execute("DELETE FROM admin_sessions WHERE expires_at<=?", (now,))
                    db.execute("DELETE FROM action_requests WHERE julianday(created_at)<julianday('now','-2 days')")
                    LAST_CLEANUP_AT = monotonic_now

    @app.after_request
    def cors(response):
        origin = request.headers.get("Origin", "").rstrip("/")
        if origin in FRONTEND_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response.headers["Access-Control-Max-Age"] = "86400"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.errorhandler(ApiError)
    def api_error(error): return jsonify(success=False,data=error.data,message=error.message),error.status
    @app.errorhandler(404)
    def missing(_): return jsonify(success=False,data={},message="Endpunkt nicht gefunden."),404
    @app.errorhandler(413)
    def too_large(_): return jsonify(success=False,data={},message="Die Anfrage ist zu groß."),413
    @app.errorhandler(Exception)
    def unexpected(error):
        app.logger.exception("API error: %s", error)
        return jsonify(success=False,data={},message="Die Anfrage konnte nicht verarbeitet werden."),500

    @app.get("/health")
    def health(): return ok({"status":"ok"})

    @app.get("/api/avatars/<filename>")
    def avatar_file(filename):
        if not re.fullmatch(r"avatar-\d+\.(png|jpg|webp)", filename):
            raise ApiError(404, "Profilbild nicht gefunden.")
        return send_from_directory(AVATAR_DIRECTORY, filename, max_age=0)

    @app.post("/api/auth/register")
    def register():
        payload = body(); username, normalized = validate_credentials(payload.get("username"),payload.get("password"))
        password_hash = bcrypt.hashpw(payload["password"].encode(),bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()
        try:
            with transaction() as db:
                now=utc_now(); cursor=db.execute("INSERT INTO users (username,username_normalized,password_hash,created_at,last_activity_at) VALUES (?,?,?,?,?)",(username,normalized,password_hash,now,now))
                user_id=cursor.lastrowid; db.execute("INSERT INTO balances (user_id,amount,updated_at) VALUES (?,1000,?)",(user_id,now)); db.execute("INSERT INTO player_stats (user_id) VALUES (?)",(user_id,))
        except sqlite3.IntegrityError: raise ApiError(409,"Dieser Benutzername ist bereits vergeben.")
        token,expires=issue_session(user_id)
        return ok({"token":token,"expiresAt":expires,"user":{"username":username,"balance":1000}},"Konto erstellt.",201)

    @app.post("/api/auth/login")
    def login():
        payload=body(); username=payload.get("username",""); password=payload.get("password","")
        if not isinstance(username,str) or not isinstance(password,str) or not username or not password or len(username)>20 or len(password)>128: raise ApiError(401,"Benutzername oder Passwort ist falsch.")
        user=get_db().execute("SELECT u.id,u.username,u.password_hash,u.is_suspended,u.suspension_reason,b.amount AS balance FROM users u JOIN balances b ON b.user_id=u.id WHERE u.username_normalized=?",(normalise(username),)).fetchone()
        fallback=b"$2b$12$C6UzMDM.H6dfI/f/IKcEe.5ZxQwDPZ9vtQd0Z4E4YW/.GQqX9vJ6G"
        if not bcrypt.checkpw(password.encode(), (user["password_hash"].encode() if user else fallback)): raise ApiError(401,"Benutzername oder Passwort ist falsch.")
        if user["is_suspended"]: raise ApiError(403,"Dieses Spielerkonto wurde gesperrt.",{"suspended":True,"reason":user["suspension_reason"] or "Kein Grund angegeben."})
        balance = restore_empty_balance(user["id"])
        token,expires=issue_session(user["id"])
        return ok({"token":token,"expiresAt":expires,"user":{"username":user["username"],"balance":balance}},"Angemeldet.")

    @app.post("/api/auth/logout")
    @auth_required
    def logout():
        get_db().execute("DELETE FROM sessions WHERE id=?",(g.auth["session_id"],)); return ok(message="Abgemeldet.")

    @app.get("/api/auth/me")
    @auth_required
    def me():
        row=get_db().execute("SELECT u.username,u.created_at,u.last_activity_at,u.avatar_filename,b.amount AS balance,s.rounds_played,s.wins,s.losses,s.pushes,s.blackjacks FROM users u JOIN balances b ON b.user_id=u.id JOIN player_stats s ON s.user_id=u.id WHERE u.id=?",(g.auth["user_id"],)).fetchone()
        user=dict(row); user["avatarUrl"]=avatar_url(user.pop("avatar_filename"))
        active_round = load_round(g.auth["user_id"])
        game = {"round": public_round(active_round, row["balance"]) if active_round else None, "balance": row["balance"]}
        return ok({"user":user, "game":game})

    @app.post("/api/profile/avatar")
    @auth_required
    def upload_avatar():
        file = request.files.get("avatar")
        if not file or not file.filename:
            raise ApiError(400, "Bitte wähle ein Profilbild aus.")
        content = file.read()
        extension = image_extension(content)
        if not extension:
            raise ApiError(400, "Erlaubt sind nur PNG-, JPG- und WebP-Bilder.")
        if not content or len(content) > 2 * 1024 * 1024:
            raise ApiError(400, "Das Profilbild darf höchstens 2 MB groß sein.")
        AVATAR_DIRECTORY.mkdir(parents=True, exist_ok=True)
        filename = f"avatar-{g.auth['user_id']}.{extension}"
        with transaction() as db:
            previous = db.execute("SELECT avatar_filename FROM users WHERE id=?", (g.auth["user_id"],)).fetchone()["avatar_filename"]
            db.execute("UPDATE users SET avatar_filename=? WHERE id=?", (filename, g.auth["user_id"]))
        if previous and previous != filename:
            old_file = AVATAR_DIRECTORY / previous
            if old_file.is_file():
                old_file.unlink()
        (AVATAR_DIRECTORY / filename).write_bytes(content)
        return ok({"avatarUrl": avatar_url(filename)}, "Profilbild aktualisiert.")

    @app.post("/api/game/start")
    @auth_required
    def game_start():
        payload=body(); bet=payload.get("bet")
        try: bet=float(bet)
        except (TypeError,ValueError): bet=0
        with transaction() as db:
            register_action(g.auth["user_id"],payload.get("actionId"),"start")
            if load_round(g.auth["user_id"]): raise ApiError(409,"Es läuft bereits eine Runde.")
            if db.execute("SELECT 1 FROM active_chicken_rounds WHERE user_id=?", (g.auth["user_id"],)).fetchone():
                raise ApiError(409, "Beende zuerst die laufende Chicken-Runde.")
            if bet<5 or bet*2 != round(bet*2): raise ApiError(400,"Der Einsatz muss mindestens 5 Chips betragen.")
            balance=db.execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()
            if not balance or bet>balance["amount"]: raise ApiError(400,"Für diesen Einsatz reichen die Chips nicht aus.")
            now=utc_now(); deck=create_shoe(); player=[draw(deck),draw(deck)]; dealer=[draw(deck),draw(deck)]
            round_={"id":str(uuid.uuid4()),"userId":g.auth["user_id"],"bet":bet,"deck":deck,"playerCards":player,"dealerCards":dealer,
                    "createdAt":now,"updatedAt":now,"luckUsed":False,"doubled":False}
            db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?",(bet,now,g.auth["user_id"]))
            db.execute("""INSERT INTO active_rounds
                        (id,user_id,bet,deck_json,player_cards_json,dealer_cards_json,created_at,updated_at,luck_used,doubled)
                        VALUES (?,?,?,?,?,?,?,?,0,0)""",
                       (round_["id"],round_["userId"],bet,json.dumps(deck),json.dumps(player),json.dumps(dealer),now,now))
            data=settle(round_,outcome(player,dealer)) if blackjack(player) or blackjack(dealer) else {"round":public_round(round_,balance["amount"]-bet),"balance":balance["amount"]-bet}
        return ok(data,data["round"]["result"]["message"] if data["round"]["status"]=="completed" else "Runde gestartet.",201)

    def game_action(kind):
        payload=body()
        with transaction():
            register_action(g.auth["user_id"],payload.get("actionId"),kind)
            round_=load_round(g.auth["user_id"])
            if not round_: raise ApiError(409,"Es läuft keine Runde.")
            round_["luckTriggered"] = False
            levels = upgrade_levels(g.auth["user_id"])
            luck_level = levels["luck"]

            def apply_luck_if_available():
                if hand_value(round_["playerCards"]) <= 21 or round_["luckUsed"] or luck_level <= 0:
                    return
                if secrets.randbelow(10_000) < luck_level * 200:
                    round_["playerCards"].pop()
                    round_["playerCards"].append(draw(round_["deck"]))
                    round_["luckUsed"] = True
                    round_["luckTriggered"] = True

            if kind=="hit":
                round_["playerCards"].append(draw(round_["deck"]))
                apply_luck_if_available()
                if hand_value(round_["playerCards"])>21: save_round(round_); return settle(round_,"loss",levels)
                if hand_value(round_["playerCards"])==21: dealer_play(round_["deck"],round_["dealerCards"]); save_round(round_); return settle(round_,outcome(round_["playerCards"],round_["dealerCards"]),levels)
                save_round(round_); balance=get_db().execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()["amount"]; return {"round":public_round(round_,balance),"balance":balance}
            if kind=="double":
                if len(round_["playerCards"])!=2: raise ApiError(409,"Verdoppeln ist nur mit zwei Karten möglich.")
                balance=get_db().execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()["amount"]
                if balance<round_["bet"]: raise ApiError(400,"Für das Verdoppeln reichen die Chips nicht aus.")
                get_db().execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?",(round_["bet"],utc_now(),g.auth["user_id"])); round_["bet"]*=2; round_["doubled"]=True; round_["playerCards"].append(draw(round_["deck"])); apply_luck_if_available(); save_round(round_)
                if hand_value(round_["playerCards"])>21: return settle(round_,"loss",levels)
            dealer_play(round_["deck"],round_["dealerCards"]); save_round(round_); return settle(round_,outcome(round_["playerCards"],round_["dealerCards"]),levels)

    @app.post("/api/game/hit")
    @auth_required
    def hit(): data=game_action("hit"); return ok(data,data["round"]["result"]["message"] if data["round"]["result"] else "Karte gegeben.")
    @app.post("/api/game/stand")
    @auth_required
    def stand(): data=game_action("stand"); return ok(data,data["round"]["result"]["message"])
    @app.post("/api/game/double")
    @auth_required
    def double(): data=game_action("double"); return ok(data,data["round"]["result"]["message"])
    @app.get("/api/game/current")
    @auth_required
    def current():
        round_=load_round(g.auth["user_id"]); balance=get_db().execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()["amount"]
        return ok({"round":public_round(round_,balance) if round_ else None,"balance":balance})

    def chicken_data(row, balance, result=None):
        active = {"bet": row["bet"], "steps": row["steps"], "payout": round(row["bet"] * CHICKEN_MULTIPLIERS[row["steps"] - 1] * 2) / 2 if row["steps"] else 0} if row else None
        return {"round": active, "balance": balance, "result": result}

    def finish_chicken(db, row, won):
        user_id, bet = row["user_id"], row["bet"]
        balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (user_id,)).fetchone()["amount"]
        payout = round(bet * CHICKEN_MULTIPLIERS[row["steps"] - 1] * 2) / 2 if won else 0
        after = balance + payout
        refilled = after == 0
        if refilled:
            after = 1000 + 250 * upgrade_levels(user_id)["starting_capital"]
        net = payout - bet
        record_big_win(db, user_id, "Chicken", net, bet)
        db.execute("UPDATE balances SET amount=?,updated_at=? WHERE user_id=?", (after, utc_now(), user_id))
        db.execute("DELETE FROM active_chicken_rounds WHERE user_id=?", (user_id,))
        stats = db.execute("SELECT current_streak,best_win_streak FROM player_stats WHERE user_id=?", (user_id,)).fetchone()
        streak = (max(0, stats["current_streak"]) + 1) if won else (min(0, stats["current_streak"]) - 1)
        db.execute("""UPDATE player_stats SET rounds_played=rounds_played+1,wins=wins+?,losses=losses+?,
                      highest_balance=MAX(highest_balance,?),biggest_win=MAX(biggest_win,?),
                      total_won=total_won+?,total_lost=total_lost+?,current_streak=?,
                      best_win_streak=MAX(best_win_streak,?) WHERE user_id=?""",
                   (int(won), int(not won), after, max(0, net), max(0, net), max(0, -net), streak, max(0, streak), user_id))
        return chicken_data(None, after, {"won": won, "steps": row["steps"], "payout": payout, "netResult": net, "refilled": refilled})

    @app.get("/api/big-wins")
    def big_wins():
        db = get_db()
        latest = db.execute("SELECT COALESCE(MAX(id),0) FROM big_wins").fetchone()[0]
        raw = request.args.get("after")
        if raw is None:
            return ok({"wins": [], "cursor": latest})
        if not raw.isdigit() or len(raw) > 18:
            raise ApiError(400, "Ungültiger Cursor.")
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        rows = db.execute("""SELECT w.id,u.username,w.game,w.amount FROM big_wins w
                             JOIN users u ON u.id=w.user_id WHERE w.id>? AND w.created_at>=?
                             ORDER BY w.id DESC LIMIT 3""", (int(raw), cutoff)).fetchall()
        return ok({"wins": [dict(row) for row in reversed(rows)], "cursor": latest})

    @app.post("/api/pinball/play")
    @auth_required
    def pinball_play():
        payload = body()
        try: bet = float(payload.get("bet"))
        except (TypeError, ValueError): bet = 0
        if not math.isfinite(bet) or bet < 5 or bet * 2 != round(bet * 2):
            raise ApiError(400, "Mindestens 5 Chips in 0,5er-Schritten einsetzen.")
        multipliers = (74, 12, 3.6, 1.5, 0.8, 0.6, 0.5, 0.6, 0.8, 1.5, 3.6, 12, 74)
        with transaction() as db:
            user_id = g.auth["user_id"]
            register_action(user_id, payload.get("actionId"), "pinball-play")
            if load_round(user_id) or db.execute("SELECT 1 FROM active_chicken_rounds WHERE user_id=?", (user_id,)).fetchone():
                raise ApiError(409, "Beende zuerst die laufende Runde.")
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (user_id,)).fetchone()["amount"]
            if bet > balance: raise ApiError(400, "Nicht genügend Chips.")
            path = [secrets.randbelow(2) for _ in range(12)]
            slot = sum(path)
            payout = round(bet * multipliers[slot] * 2) / 2
            net = payout - bet
            after = balance + net
            if after == 0: after = 1000 + 250 * upgrade_levels(user_id)["starting_capital"]
            db.execute("UPDATE balances SET amount=?,updated_at=? WHERE user_id=?", (after, utc_now(), user_id))
            db.execute("""UPDATE player_stats SET rounds_played=rounds_played+1,wins=wins+?,losses=losses+?,
                          highest_balance=MAX(highest_balance,?),biggest_win=MAX(biggest_win,?),
                          total_won=total_won+?,total_lost=total_lost+? WHERE user_id=?""",
                       (int(net>0), int(net<0), after, max(0,net), max(0,net), max(0,-net), user_id))
            record_big_win(db, user_id, "Pinball", net, bet)
        return ok({"path": path, "slot": slot, "multiplier": multipliers[slot], "payout": payout, "netResult": net, "balance": after})

    @app.get("/api/chicken/current")
    @auth_required
    def chicken_current():
        db = get_db()
        row = db.execute("SELECT * FROM active_chicken_rounds WHERE user_id=?", (g.auth["user_id"],)).fetchone()
        balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
        return ok(chicken_data(row, balance))

    @app.post("/api/chicken/start")
    @auth_required
    def chicken_start():
        payload = body()
        try: bet = float(payload.get("bet"))
        except (TypeError, ValueError): bet = 0
        if not math.isfinite(bet) or bet < 5 or bet * 2 != round(bet * 2):
            raise ApiError(400, "Der Einsatz muss mindestens 5 Chips betragen und in 0,5er-Schritten liegen.")
        with transaction() as db:
            register_action(g.auth["user_id"], payload.get("actionId"), "chicken-start")
            if load_round(g.auth["user_id"]) or db.execute("SELECT 1 FROM active_chicken_rounds WHERE user_id=?", (g.auth["user_id"],)).fetchone():
                raise ApiError(409, "Beende zuerst die laufende Runde.")
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
            if bet > balance: raise ApiError(400, "Für diesen Einsatz reichen die Chips nicht aus.")
            db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?", (bet, utc_now(), g.auth["user_id"]))
            db.execute("INSERT INTO active_chicken_rounds (id,user_id,bet,steps,created_at) VALUES (?,?,?,0,?)",
                       (str(uuid.uuid4()), g.auth["user_id"], bet, utc_now()))
        return ok(chicken_data({"bet": bet, "steps": 0}, balance - bet), "Chicken-Runde gestartet.", 201)

    @app.post("/api/chicken/step")
    @auth_required
    def chicken_step():
        payload = body()
        with transaction() as db:
            register_action(g.auth["user_id"], payload.get("actionId"), "chicken-step")
            row = db.execute("SELECT * FROM active_chicken_rounds WHERE user_id=?", (g.auth["user_id"],)).fetchone()
            if not row: raise ApiError(409, "Es läuft keine Chicken-Runde.")
            if row["steps"] >= len(CHICKEN_MULTIPLIERS):
                return ok(finish_chicken(db, row, True), "Alle Schritte geschafft!")
            if secrets.randbelow(100) >= CHICKEN_SUCCESS_CHANCES[row["steps"]]:
                return ok(finish_chicken(db, row, False), "Der Schritt ging schief.")
            steps = row["steps"] + 1
            db.execute("UPDATE active_chicken_rounds SET steps=? WHERE user_id=?", (steps, g.auth["user_id"]))
            row = dict(row) | {"steps": steps}
            if steps == len(CHICKEN_MULTIPLIERS):
                return ok(finish_chicken(db, row, True), "Alle Schritte geschafft!")
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
            return ok(chicken_data(row, balance), "Schritt geschafft.")

    @app.post("/api/chicken/cashout")
    @auth_required
    def chicken_cashout():
        payload = body()
        with transaction() as db:
            register_action(g.auth["user_id"], payload.get("actionId"), "chicken-cashout")
            row = db.execute("SELECT * FROM active_chicken_rounds WHERE user_id=?", (g.auth["user_id"],)).fetchone()
            if not row or row["steps"] == 0: raise ApiError(409, "Gehe zuerst mindestens einen Schritt.")
            return ok(finish_chicken(db, row, True), "Gewinn gesichert.")

    @app.get("/api/upgrades")
    @auth_required
    def upgrades():
        balance = get_db().execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
        return ok(public_upgrades(g.auth["user_id"], balance))

    @app.post("/api/upgrades/<upgrade_key>/buy")
    @auth_required
    def buy_upgrade(upgrade_key):
        if upgrade_key not in UPGRADES:
            raise ApiError(404, "Upgrade nicht gefunden.")
        payload = body()
        with transaction() as db:
            register_action(g.auth["user_id"], payload.get("actionId"), f"upgrade-{upgrade_key}")
            if load_round(g.auth["user_id"]):
                raise ApiError(409, "Während einer laufenden Runde können keine Upgrades gekauft werden.")
            row = db.execute("SELECT level FROM user_upgrades WHERE user_id=? AND upgrade_key=?",
                             (g.auth["user_id"], upgrade_key)).fetchone()
            level = row["level"] if row else 0
            if level >= MAX_UPGRADE_LEVEL:
                raise ApiError(409, "Dieses Upgrade hat bereits das Maximallevel erreicht.")
            price = upgrade_price(upgrade_key, level)
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
            if balance < price:
                raise ApiError(400, "Für dieses Upgrade reichen die Chips nicht aus.")
            now = utc_now()
            db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?", (price, now, g.auth["user_id"]))
            db.execute("""INSERT INTO user_upgrades (user_id,upgrade_key,level,updated_at) VALUES (?,?,1,?)
                          ON CONFLICT(user_id,upgrade_key) DO UPDATE SET level=level+1,updated_at=excluded.updated_at""",
                       (g.auth["user_id"], upgrade_key, now))
            new_balance = balance - price
        return ok(public_upgrades(g.auth["user_id"], new_balance), f"{UPGRADES[upgrade_key]['name']} verbessert.")

    @app.post("/api/upgrades/daily-bonus/claim")
    @auth_required
    def claim_daily_bonus():
        payload = body()
        with transaction() as db:
            register_action(g.auth["user_id"], payload.get("actionId"), "daily-bonus")
            if load_round(g.auth["user_id"]):
                raise ApiError(409, "Der Tagesbonus kann erst nach der laufenden Runde abgeholt werden.")
            levels = upgrade_levels(g.auth["user_id"])
            daily = daily_bonus_state(g.auth["user_id"], levels)
            if levels["daily_bonus"] <= 0:
                raise ApiError(409, "Kaufe zuerst das Tagesbonus-Upgrade.")
            if not daily["available"]:
                raise ApiError(409, "Der Tagesbonus ist noch nicht wieder verfügbar.")
            now = utc_now()
            db.execute("UPDATE balances SET amount=amount+?,updated_at=? WHERE user_id=?",
                       (daily["amount"], now, g.auth["user_id"]))
            db.execute("""INSERT INTO upgrade_claims (user_id,last_daily_claim_at) VALUES (?,?)
                          ON CONFLICT(user_id) DO UPDATE SET last_daily_claim_at=excluded.last_daily_claim_at""",
                       (g.auth["user_id"], now))
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (g.auth["user_id"],)).fetchone()["amount"]
        return ok(public_upgrades(g.auth["user_id"], balance), f"{daily['amount']} Chips Tagesbonus erhalten.")

    @app.get("/api/leaderboard")
    @auth_required
    def leaderboard():
        page=positive_int(request.args.get("page"),1); limit=positive_int(request.args.get("limit"),25,100)
        db=get_db(); total=db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]; pages=max(1,(total+limit-1)//limit); page=min(page,pages)
        rows=db.execute("""SELECT u.username,u.avatar_filename,b.amount AS balance,s.rounds_played,s.wins,s.losses,RANK() OVER (ORDER BY b.amount DESC) AS rank FROM users u JOIN balances b ON b.user_id=u.id JOIN player_stats s ON s.user_id=u.id ORDER BY b.amount DESC,u.username_normalized ASC LIMIT ? OFFSET ?""",(limit,(page-1)*limit)).fetchall()
        players=[] 
        for row in rows:
            win,_=rates(row); players.append({"rank":row["rank"],"username":row["username"],"avatarUrl":avatar_url(row["avatar_filename"]),"balance":row["balance"],"roundsPlayed":row["rounds_played"],"winRate":win,"isCurrentUser":normalise(row["username"])==normalise(g.auth["username"])})
        return ok({"players":players,"pagination":{"page":page,"limit":limit,"total":total,"totalPages":pages}})

    @app.get("/api/players/<username>")
    @auth_required
    def profile(username):
        if not USERNAME_RE.fullmatch(username): raise ApiError(400,"Ungültiger Benutzername.")
        row=get_db().execute("""SELECT u.id,u.username,u.created_at,u.last_activity_at,u.avatar_filename,b.amount AS balance,s.*, (SELECT 1+COUNT(*) FROM balances other WHERE other.amount>b.amount) AS rank FROM users u JOIN balances b ON b.user_id=u.id JOIN player_stats s ON s.user_id=u.id WHERE u.username_normalized=?""",(normalise(username),)).fetchone()
        if not row: raise ApiError(404,"Spieler nicht gefunden.")
        win,loss=rates(row); streak={"type":"win","count":row["current_streak"]} if row["current_streak"]>0 else ({"type":"loss","count":abs(row["current_streak"])} if row["current_streak"]<0 else {"type":"none","count":0})
        keys={"username":"username","balance":"balance","rank":"rank","roundsPlayed":"rounds_played","wins":"wins","losses":"losses","pushes":"pushes","blackjacks":"blackjacks","highestBalance":"highest_balance","biggestWin":"biggest_win","totalWon":"total_won","totalLost":"total_lost","bestWinStreak":"best_win_streak","totalPlaySeconds":"total_play_seconds","registeredAt":"created_at","lastActivityAt":"last_activity_at"}
        player={out:row[key] for out,key in keys.items()}; player.update(avatarUrl=avatar_url(row["avatar_filename"]),winRate=win,lossRate=loss,currentStreak=streak,isCurrentUser=row["id"]==g.auth["user_id"])
        return ok({"player":player})

    @app.post("/api/activity")
    @auth_required
    def activity():
        active=body().get("active")
        if not isinstance(active,bool): raise ApiError(400,"Das Aktivitätsfeld muss true oder false sein.")
        with transaction() as db:
            existing=db.execute("SELECT * FROM activity_sessions WHERE session_id=?",(g.auth["session_id"],)).fetchone(); now=utc_now(); credited=0
            if not existing: db.execute("INSERT INTO activity_sessions VALUES (?,?,?,?,?,0)",(g.auth["session_id"],g.auth["user_id"],now,now,int(active)))
            else:
                elapsed=int((datetime.fromisoformat(now.replace("Z","+00:00"))-datetime.fromisoformat(existing["last_ping_at"].replace("Z","+00:00"))).total_seconds())
                # Der Browser pingt nur noch alle zwei Minuten. Ein großzügiger
                # Grenzwert toleriert langsame Hosts, ohne Offline-Zeit endlos anzurechnen.
                credited=min(elapsed,150) if active and existing["is_active"] and 0<elapsed<=240 else 0
                db.execute("UPDATE activity_sessions SET last_ping_at=?,is_active=?,accrued_seconds=accrued_seconds+? WHERE session_id=?",(now,int(active),credited,g.auth["session_id"]))
                if credited: db.execute("UPDATE player_stats SET total_play_seconds=total_play_seconds+? WHERE user_id=?",(credited,g.auth["user_id"]))
        return ok({"creditedSeconds":credited})

    @app.post("/api/admin/login")
    def admin_login():
        password=body().get("password","")
        if not isinstance(password,str) or len(password)>128 or not hmac.compare_digest(hashlib.sha256(password.encode()).digest(),hashlib.sha256(ADMIN_PASSWORD.encode()).digest()): raise ApiError(401,"Das Admin-Passwort ist falsch.")
        token=new_token(); now=datetime.now(timezone.utc); expires=now+timedelta(hours=8); now_s=now.isoformat(timespec="milliseconds").replace("+00:00","Z"); expires_s=expires.isoformat(timespec="milliseconds").replace("+00:00","Z")
        get_db().execute("INSERT INTO admin_sessions (token_hash,created_at,expires_at,last_used_at) VALUES (?,?,?,?)",(token_hash(token),now_s,expires_s,now_s))
        return ok({"token":token,"expiresAt":expires_s},"Admin-Sitzung gestartet.")

    @app.post("/api/admin/logout")
    @admin_required
    def admin_logout(): get_db().execute("DELETE FROM admin_sessions WHERE id=?",(g.admin["id"],)); return ok(message="Admin-Sitzung beendet.")

    @app.get("/api/admin/players")
    @admin_required
    def admin_players():
        page=positive_int(request.args.get("page"),1); search=request.args.get("search","").strip()[:20].lower(); limit=50; db=get_db(); total=db.execute("SELECT COUNT(*) AS n FROM users WHERE username_normalized LIKE ?",(f"%{search}%",)).fetchone()["n"]; pages=max(1,(total+limit-1)//limit); page=min(page,pages)
        rows=db.execute("""SELECT u.id,u.username,u.created_at,u.last_activity_at,u.is_suspended,u.suspension_reason,u.suspended_at,b.amount AS balance,s.rounds_played,s.wins,s.losses,EXISTS(SELECT 1 FROM active_rounds r WHERE r.user_id=u.id) AS has_active_round FROM users u JOIN balances b ON b.user_id=u.id JOIN player_stats s ON s.user_id=u.id WHERE u.username_normalized LIKE ? ORDER BY u.username_normalized LIMIT ? OFFSET ?""",(f"%{search}%",limit,(page-1)*limit)).fetchall()
        players=[{"id":r["id"],"username":r["username"],"balance":r["balance"],"roundsPlayed":r["rounds_played"],"wins":r["wins"],"losses":r["losses"],"suspended":bool(r["is_suspended"]),"suspensionReason":r["suspension_reason"],"suspendedAt":r["suspended_at"],"hasActiveRound":bool(r["has_active_round"]),"createdAt":r["created_at"],"lastActivityAt":r["last_activity_at"]} for r in rows]
        return ok({"players":players,"pagination":{"page":page,"limit":limit,"total":total,"totalPages":pages}})

    def admin_player_id(value):
        try: player_id=int(value)
        except ValueError: raise ApiError(400,"Ungültige Spieler-ID.")
        if player_id<1: raise ApiError(400,"Ungültige Spieler-ID.")
        return player_id

    @app.patch("/api/admin/players/<id>/balance")
    @admin_required
    def set_balance(id):
        payload=body(); player_id=admin_player_id(id)
        try: amount=float(payload.get("amount"))
        except (ValueError,TypeError): amount=-1
        reason=payload.get("reason",""); reason=reason.strip()[:300] if isinstance(reason,str) else ""
        if amount<0 or amount>1_000_000_000 or amount*2!=round(amount*2): raise ApiError(400,"Das Guthaben muss zwischen 0 und 1.000.000.000 liegen und auf halbe Chips gerundet sein.")
        with transaction() as db:
            player=db.execute("SELECT b.amount AS balance,EXISTS(SELECT 1 FROM active_rounds r WHERE r.user_id=u.id) AS active FROM users u JOIN balances b ON b.user_id=u.id WHERE u.id=?",(player_id,)).fetchone()
            if not player: raise ApiError(404,"Spieler nicht gefunden.")
            if player["active"]: raise ApiError(409,"Das Guthaben kann während einer laufenden Runde nicht geändert werden.")
            now=utc_now(); db.execute("UPDATE balances SET amount=?,updated_at=? WHERE user_id=?",(amount,now,player_id)); db.execute("UPDATE player_stats SET highest_balance=MAX(highest_balance,?) WHERE user_id=?",(amount,player_id)); audit(player_id,"balance",player["balance"],amount,reason or None)
        return ok({"balance":amount},"Guthaben aktualisiert.")

    @app.patch("/api/admin/players/<id>/username")
    @admin_required
    def rename(id):
        payload=body(); player_id=admin_player_id(id); username=payload.get("username","").strip() if isinstance(payload.get("username"),str) else ""
        if not USERNAME_RE.fullmatch(username): raise ApiError(400,"Der Benutzername muss 3–20 Zeichen lang sein und darf Buchstaben, Zahlen, _ und - enthalten.")
        try:
            with transaction() as db:
                player=db.execute("SELECT username FROM users WHERE id=?",(player_id,)).fetchone()
                if not player: raise ApiError(404,"Spieler nicht gefunden.")
                db.execute("UPDATE users SET username=?,username_normalized=? WHERE id=?",(username,normalise(username),player_id)); audit(player_id,"username",player["username"],username)
        except sqlite3.IntegrityError: raise ApiError(409,"Dieser Benutzername ist bereits vergeben.")
        return ok({"username":username},"Benutzername aktualisiert.")

    @app.patch("/api/admin/players/<id>/suspension")
    @admin_required
    def suspension(id):
        payload=body(); player_id=admin_player_id(id); suspended=payload.get("suspended"); reason=payload.get("reason","").strip() if isinstance(payload.get("reason"),str) else ""
        if not isinstance(suspended,bool): raise ApiError(400,"Der Sperrstatus fehlt.")
        if suspended and not 3<=len(reason)<=300: raise ApiError(400,"Für eine Sperre ist eine Begründung mit 3–300 Zeichen erforderlich.")
        with transaction() as db:
            player=db.execute("SELECT is_suspended,suspension_reason FROM users WHERE id=?",(player_id,)).fetchone()
            if not player: raise ApiError(404,"Spieler nicht gefunden.")
            now=utc_now(); db.execute("UPDATE users SET is_suspended=?,suspension_reason=?,suspended_at=? WHERE id=?",(int(suspended),reason if suspended else None,now if suspended else None,player_id)); audit(player_id,"suspend" if suspended else "unsuspend",{"suspended":bool(player["is_suspended"]),"reason":player["suspension_reason"]},{"suspended":suspended,"reason":reason if suspended else None},reason if suspended else None)
        return ok({"suspended":suspended,"reason":reason if suspended else None},"Spieler gesperrt." if suspended else "Sperre aufgehoben.")

    return app


app = make_app()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST","127.0.0.1"), port=parse_int(os.environ.get("PORT"),3000,1,65535), debug=False)
