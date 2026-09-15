"""Watt Casino API – Flask/SQLite backend for PythonAnywhere."""
from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
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
 deck_json TEXT NOT NULL, player_cards_json TEXT NOT NULL, dealer_cards_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_user_id, created_at DESC);
"""


def initialise_database(app: Flask) -> None:
    with app.app_context():
        db = get_db()
        db.executescript(SCHEMA)
        for name, definition in [
            ("is_suspended", "INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0,1))"),
            ("suspension_reason", "TEXT"),
            ("suspended_at", "TEXT"),
            ("avatar_filename", "TEXT"),
        ]:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
            if name not in columns:
                db.execute(f"ALTER TABLE users ADD COLUMN {name} {definition}")


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


def auth_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme != "Bearer" or not token or len(token) > 200:
            raise ApiError(401, "Bitte erneut anmelden.")
        db = get_db()
        session = db.execute(
            """SELECT s.id AS session_id,s.user_id,s.expires_at,u.username,u.is_suspended,u.suspension_reason,b.amount AS balance
               FROM sessions s JOIN users u ON u.id=s.user_id JOIN balances b ON b.user_id=u.id WHERE s.token_hash=?""",
            (token_hash(token),),
        ).fetchone()
        if not session or session["expires_at"] <= utc_now():
            if session:
                db.execute("DELETE FROM sessions WHERE id=?", (session["session_id"],))
            raise ApiError(401, "Die Sitzung ist abgelaufen. Bitte erneut anmelden.")
        if session["is_suspended"]:
            raise ApiError(403, "Dieses Spielerkonto wurde gesperrt.", {"suspended": True, "reason": session["suspension_reason"] or "Kein Grund angegeben."})
        g.auth = dict(session)
        now = utc_now()
        db.execute("UPDATE sessions SET last_used_at=? WHERE id=?", (now, session["session_id"]))
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
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def load_round(user_id): return parse_round(get_db().execute("SELECT * FROM active_rounds WHERE user_id=?", (user_id,)).fetchone())


def save_round(round_):
    now = utc_now()
    get_db().execute("""UPDATE active_rounds SET bet=?,deck_json=?,player_cards_json=?,dealer_cards_json=?,updated_at=? WHERE id=? AND user_id=?""",
                     (round_["bet"], json.dumps(round_["deck"]), json.dumps(round_["playerCards"]), json.dumps(round_["dealerCards"]), now, round_["id"], round_["userId"]))
    round_["updatedAt"] = now


def public_round(round_, balance, reveal=False, result=None):
    dealer = round_["dealerCards"] if reveal else [({"hidden": True} if i == 1 else card) for i, card in enumerate(round_["dealerCards"])]
    allowed = [] if result else ["hit", "stand"] + (["double"] if len(round_["playerCards"]) == 2 and balance >= round_["bet"] else [])
    return {"id": round_["id"], "bet": round_["bet"], "playerCards": round_["playerCards"], "dealerCards": dealer,
            "playerValue": hand_value(round_["playerCards"]), "dealerValue": hand_value(round_["dealerCards"] if reveal else [round_["dealerCards"][0]]),
            "dealerRevealed": reveal, "status": "completed" if result else "active", "allowedActions": allowed, "result": result, "startedAt": round_["createdAt"]}


def register_action(user_id, action_id, action_type):
    if not isinstance(action_id, str) or not ACTION_RE.fullmatch(action_id):
        raise ApiError(400, "Für diese Aktion fehlt eine gültige Aktions-ID.")
    try:
        get_db().execute("INSERT INTO action_requests (user_id,action_id,action_type,created_at) VALUES (?,?,?,?)", (user_id, action_id, action_type, utc_now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "Diese Aktion wurde bereits verarbeitet.")


def settle(round_, result):
    db = get_db()
    balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (round_["userId"],)).fetchone()
    if not balance: raise ApiError(404, "Spielerkonto nicht gefunden.")
    multiplier = {"blackjack": 2.5, "win": 2, "push": 1, "loss": 0}[result]
    payout = round_["bet"] * multiplier
    before = balance["amount"] + round_["bet"]
    raw_after = balance["amount"] + payout
    after, refilled = (1000, True) if raw_after <= 0 else (raw_after, False)
    completed = utc_now()
    duration = max(0, min(86400, int((datetime.fromisoformat(completed.replace("Z","+00:00")) - datetime.fromisoformat(round_["createdAt"].replace("Z","+00:00"))).total_seconds())))
    net = after - before
    db.execute("UPDATE balances SET amount=?,updated_at=? WHERE user_id=?", (after, completed, round_["userId"]))
    stats = db.execute("SELECT * FROM player_stats WHERE user_id=?", (round_["userId"],)).fetchone()
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
    message = outcome_message(result,round_["playerCards"],round_["dealerCards"]) + (" Kontostand automatisch auf 1.000 Chips erneuert." if refilled else "")
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
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
    initialise_database(app)

    @app.teardown_appcontext
    def close_db(_error=None):
        db = g.pop("db", None)
        if db: db.close()

    @app.before_request
    def cors_and_cleanup():
        if request.method == "OPTIONS":
            return ("", 204)
        if request.path.startswith("/api/"):
            enforce_rate_limit("api", 180, 60)
        if request.path in {"/api/auth/register", "/api/auth/login"}:
            enforce_rate_limit("auth", 20, 15 * 60)
        if request.path == "/api/admin/login":
            enforce_rate_limit("admin-login", 5, 15 * 60)
        now = utc_now()
        db = get_db()
        db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
        db.execute("DELETE FROM admin_sessions WHERE expires_at<=?", (now,))
        db.execute("DELETE FROM action_requests WHERE julianday(created_at)<julianday('now','-2 days')")

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
        return send_from_directory(AVATAR_DIRECTORY, filename, max_age=3600)

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
        token,expires=issue_session(user["id"])
        return ok({"token":token,"expiresAt":expires,"user":{"username":user["username"],"balance":user["balance"]}},"Angemeldet.")

    @app.post("/api/auth/logout")
    @auth_required
    def logout():
        get_db().execute("DELETE FROM sessions WHERE id=?",(g.auth["session_id"],)); return ok(message="Abgemeldet.")

    @app.get("/api/auth/me")
    @auth_required
    def me():
        row=get_db().execute("SELECT u.username,u.created_at,u.last_activity_at,u.avatar_filename,b.amount AS balance,s.rounds_played,s.wins,s.losses,s.pushes,s.blackjacks FROM users u JOIN balances b ON b.user_id=u.id JOIN player_stats s ON s.user_id=u.id WHERE u.id=?",(g.auth["user_id"],)).fetchone()
        user=dict(row); user["avatarUrl"]=avatar_url(user.pop("avatar_filename"))
        return ok({"user":user})

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
            if bet<5 or bet*2 != round(bet*2): raise ApiError(400,"Der Einsatz muss mindestens 5 Chips betragen.")
            balance=db.execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()
            if not balance or bet>balance["amount"]: raise ApiError(400,"Für diesen Einsatz reichen die Chips nicht aus.")
            now=utc_now(); deck=create_shoe(); player=[draw(deck),draw(deck)]; dealer=[draw(deck),draw(deck)]
            round_={"id":str(uuid.uuid4()),"userId":g.auth["user_id"],"bet":bet,"deck":deck,"playerCards":player,"dealerCards":dealer,"createdAt":now,"updatedAt":now}
            db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?",(bet,now,g.auth["user_id"]))
            db.execute("INSERT INTO active_rounds VALUES (?,?,?,?,?,?,?,?)",(round_["id"],round_["userId"],bet,json.dumps(deck),json.dumps(player),json.dumps(dealer),now,now))
            data=settle(round_,outcome(player,dealer)) if blackjack(player) or blackjack(dealer) else {"round":public_round(round_,balance["amount"]-bet),"balance":balance["amount"]-bet}
        return ok(data,data["round"]["result"]["message"] if data["round"]["status"]=="completed" else "Runde gestartet.",201)

    def game_action(kind):
        payload=body()
        with transaction():
            register_action(g.auth["user_id"],payload.get("actionId"),kind)
            round_=load_round(g.auth["user_id"])
            if not round_: raise ApiError(409,"Es läuft keine Runde.")
            if kind=="hit":
                round_["playerCards"].append(draw(round_["deck"]))
                if hand_value(round_["playerCards"])>21: save_round(round_); return settle(round_,"loss")
                if hand_value(round_["playerCards"])==21: dealer_play(round_["deck"],round_["dealerCards"]); save_round(round_); return settle(round_,outcome(round_["playerCards"],round_["dealerCards"]))
                save_round(round_); balance=get_db().execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()["amount"]; return {"round":public_round(round_,balance),"balance":balance}
            if kind=="double":
                if len(round_["playerCards"])!=2: raise ApiError(409,"Verdoppeln ist nur mit zwei Karten möglich.")
                balance=get_db().execute("SELECT amount FROM balances WHERE user_id=?",(g.auth["user_id"],)).fetchone()["amount"]
                if balance<round_["bet"]: raise ApiError(400,"Für das Verdoppeln reichen die Chips nicht aus.")
                get_db().execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?",(round_["bet"],utc_now(),g.auth["user_id"])); round_["bet"]*=2; round_["playerCards"].append(draw(round_["deck"])); save_round(round_)
                if hand_value(round_["playerCards"])>21: return settle(round_,"loss")
            dealer_play(round_["deck"],round_["dealerCards"]); save_round(round_); return settle(round_,outcome(round_["playerCards"],round_["dealerCards"]))

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
                credited=min(elapsed,45) if active and existing["is_active"] and 0<elapsed<=60 else 0
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
