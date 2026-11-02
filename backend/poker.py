"""Two-player, server-authoritative Texas Hold'em lobbies."""
import itertools
import json
import math
import secrets
import string

from flask import g

SCHEMA = """
CREATE TABLE IF NOT EXISTS poker_lobbies (
 code TEXT PRIMARY KEY, host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS poker_members (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 lobby_code TEXT NOT NULL REFERENCES poker_lobbies(code) ON DELETE CASCADE,
 joined_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_poker_members_lobby ON poker_members(lobby_code);
"""

RANKS = "23456789TJQKA"
SUITS = "shdc"
ANTE = 10
STREETS = ("preflop", "flop", "turn", "river")
HAND_NAMES = ("Höchste Karte", "Ein Paar", "Zwei Paare", "Drilling", "Straße", "Flush",
              "Full House", "Vierling", "Straight Flush")


def lobby_name(value):
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())
    if not 3 <= len(name) <= 30 or not name.isprintable():
        return None
    return name


def score_five(cards):
    values = sorted((RANKS.index(card[0]) + 2 for card in cards), reverse=True)
    counts = {value: values.count(value) for value in set(values)}
    groups = sorted(((count, value) for value, count in counts.items()), reverse=True)
    flush = len({card[1] for card in cards}) == 1
    unique = sorted(set(values), reverse=True)
    if 14 in unique:
        unique.append(1)
    straight = next((unique[i] for i in range(len(unique) - 4)
                     if unique[i] - unique[i + 4] == 4), 0)
    if straight and flush:
        return (8, straight)
    if groups[0][0] == 4:
        return (7, groups[0][1], groups[1][1])
    if groups[0][0] == 3 and groups[1][0] == 2:
        return (6, groups[0][1], groups[1][1])
    if flush:
        return (5, *values)
    if straight:
        return (4, straight)
    if groups[0][0] == 3:
        return (3, groups[0][1], *sorted((v for v in values if v != groups[0][1]), reverse=True))
    if groups[0][0] == 2 and groups[1][0] == 2:
        pairs = sorted((groups[0][1], groups[1][1]), reverse=True)
        return (2, *pairs, next(v for v in values if v not in pairs))
    if groups[0][0] == 2:
        return (1, groups[0][1], *sorted((v for v in values if v != groups[0][1]), reverse=True))
    return (0, *values)


def best_hand(cards):
    return max(score_five(hand) for hand in itertools.combinations(cards, 5))


def ensure_betting(hand):
    """Keep unfinished hands created by the earlier check-only version playable."""
    ids = list(hand["cards"])
    hand.setdefault("invested", {pid: ANTE for pid in ids})
    hand.setdefault("contributions", {pid: 0 for pid in ids})
    hand.setdefault("currentBet", 0)
    hand.setdefault("acted", hand.get("checked", []))
    hand.setdefault("turn", next((int(pid) for pid in ids if int(pid) not in hand["acted"]), int(ids[0])))


def betting_limits(db, hand, user_id):
    ids = list(hand["cards"])
    mine, other = str(user_id), next(pid for pid in ids if pid != str(user_id))
    to_call = round((hand["currentBet"] - hand["contributions"][mine]) * 2) / 2
    balances = {pid: db.execute("SELECT amount FROM balances WHERE user_id=?", (int(pid),)).fetchone()["amount"]
                for pid in ids}
    max_total = min(hand["contributions"][pid] + balances[pid] for pid in ids)
    max_raise = max(0, round((max_total - hand["currentBet"]) * 2) / 2)
    return to_call, max_raise, balances[mine], int(other)


def install(app, context):
    db_for = context["get_db"]
    transaction = context["transaction"]
    auth = context["auth_required"]
    ApiError = context["ApiError"]
    ok = context["ok"]
    body = context["body"]
    utc_now = context["utc_now"]
    register_action = context["register_action"]
    record_big_win = context["record_big_win"]

    def membership(db, user_id):
        return db.execute("SELECT lobby_code FROM poker_members WHERE user_id=?", (user_id,)).fetchone()

    def lobby(db, code):
        row = db.execute("SELECT * FROM poker_lobbies WHERE code=?", (code,)).fetchone()
        if not row:
            raise ApiError(404, "Lobby nicht gefunden.")
        return row, json.loads(row["state_json"])

    def save(db, code, state):
        db.execute("UPDATE poker_lobbies SET state_json=? WHERE code=?", (json.dumps(state), code))

    def public(db, code, user_id):
        row, state = lobby(db, code)
        players = [dict(member) for member in db.execute("""
            SELECT m.user_id AS id,u.username FROM poker_members m JOIN users u ON u.id=m.user_id
            WHERE m.lobby_code=? ORDER BY m.joined_at,m.user_id""", (code,))]
        hand = state.get("hand")
        result = {
            "name": state.get("name", f"Poker-Lobby {code}"), "hostId": row["host_id"], "meId": user_id,
            "players": players, "status": state["status"], "ante": ANTE,
            "balance": db.execute("SELECT amount FROM balances WHERE user_id=?", (user_id,)).fetchone()["amount"],
        }
        if hand:
            ensure_betting(hand)
            visible = 0 if hand["street"] == "preflop" else 3 if hand["street"] == "flop" else 4 if hand["street"] == "turn" else 5
            if state["status"] == "finished":
                visible = 5
            to_call, max_raise, _, _ = betting_limits(db, hand, user_id)
            result["hand"] = {
                "street": hand["street"], "board": hand["board"][:visible],
                "cards": hand["cards"].get(str(user_id), []), "pot": hand["pot"],
                "turnId": hand["turn"], "toCall": to_call, "maxRaise": max_raise,
                "currentBet": hand["currentBet"], "invested": hand["invested"],
                "result": hand.get("result"),
                "opponentCards": {key: value for key, value in hand["cards"].items() if key != str(user_id)}
                if state["status"] == "finished" and hand.get("result", {}).get("reveal") else {},
            }
        return result

    @app.get("/api/poker/current")
    @auth
    def poker_current():
        db = db_for()
        member = membership(db, g.auth["user_id"])
        return ok({"lobby": public(db, member["lobby_code"], g.auth["user_id"]) if member else None})

    @app.get("/api/poker/lobbies")
    @auth
    def poker_lobbies():
        db = db_for()
        result = []
        for row in db.execute("""SELECT l.code,l.state_json,u.username AS host,
            COUNT(m.user_id) AS players FROM poker_lobbies l
            JOIN users u ON u.id=l.host_id
            LEFT JOIN poker_members m ON m.lobby_code=l.code
            WHERE json_extract(l.state_json,'$.status')='waiting'
            GROUP BY l.code HAVING COUNT(m.user_id)<2
            ORDER BY l.created_at DESC LIMIT 100"""):
            state = json.loads(row["state_json"])
            result.append({"name": state.get("name", f"Poker-Lobby {row['code']}"),
                           "host": row["host"], "players": row["players"]})
        return ok({"lobbies": result})

    @app.post("/api/poker/create")
    @auth
    def poker_create():
        name = lobby_name(body().get("name"))
        if not name:
            raise ApiError(400, "Der Lobby-Name muss 3–30 sichtbare Zeichen haben.")
        with transaction() as db:
            uid = g.auth["user_id"]
            if membership(db, uid):
                raise ApiError(409, "Du bist bereits in einer Poker-Lobby.")
            if any(json.loads(row["state_json"]).get("name", f"Poker-Lobby {row['code']}").casefold() == name.casefold()
                   for row in db.execute("SELECT code,state_json FROM poker_lobbies")):
                raise ApiError(409, "Dieser Lobby-Name ist bereits vergeben.")
            alphabet = string.ascii_uppercase + string.digits
            for _ in range(8):
                code = "".join(secrets.choice(alphabet) for _ in range(6))
                if not db.execute("SELECT 1 FROM poker_lobbies WHERE code=?", (code,)).fetchone():
                    break
            else:
                raise ApiError(503, "Lobby-Code konnte nicht erstellt werden.")
            now = utc_now()
            db.execute("INSERT INTO poker_lobbies VALUES (?,?,?,?)", (code, uid, json.dumps({"status": "waiting", "name": name}), now))
            db.execute("INSERT INTO poker_members VALUES (?,?,?)", (uid, code, now))
            result = public(db, code, uid)
        return ok({"lobby": result}, "Lobby erstellt.", 201)

    @app.post("/api/poker/join")
    @auth
    def poker_join():
        name = lobby_name(body().get("name"))
        if not name:
            raise ApiError(400, "Bitte wähle eine Lobby aus der Liste.")
        with transaction() as db:
            uid = g.auth["user_id"]
            if membership(db, uid):
                raise ApiError(409, "Du bist bereits in einer Poker-Lobby.")
            match = next((row for row in db.execute("SELECT code,state_json FROM poker_lobbies")
                          if json.loads(row["state_json"]).get("name", f"Poker-Lobby {row['code']}").casefold() == name.casefold()), None)
            if not match:
                raise ApiError(404, "Diese Lobby ist nicht mehr verfügbar.")
            code = match["code"]
            _, state = lobby(db, code)
            if state["status"] != "waiting":
                raise ApiError(409, "Diese Lobby hat bereits begonnen.")
            if db.execute("SELECT COUNT(*) AS n FROM poker_members WHERE lobby_code=?", (code,)).fetchone()["n"] >= 2:
                raise ApiError(409, "Diese Lobby ist voll.")
            db.execute("INSERT INTO poker_members VALUES (?,?,?)", (uid, code, utc_now()))
            result = public(db, code, uid)
        return ok({"lobby": result}, "Lobby beigetreten.")

    @app.post("/api/poker/leave")
    @auth
    def poker_leave():
        with transaction() as db:
            uid = g.auth["user_id"]
            member = membership(db, uid)
            if not member:
                raise ApiError(409, "Du bist in keiner Poker-Lobby.")
            code = member["lobby_code"]
            row, state = lobby(db, code)
            if state["status"] == "playing":
                finish(db, code, state, next(int(pid) for pid in state["hand"]["cards"] if int(pid) != uid), "Der andere Spieler hat den Tisch verlassen.")
            db.execute("DELETE FROM poker_members WHERE user_id=?", (uid,))
            other = db.execute("SELECT user_id FROM poker_members WHERE lobby_code=?", (code,)).fetchone()
            if other:
                if row["host_id"] == uid:
                    db.execute("UPDATE poker_lobbies SET host_id=? WHERE code=?", (other["user_id"], code))
                save(db, code, {"status": "waiting", "name": state.get("name", f"Poker-Lobby {code}")})
            else:
                db.execute("DELETE FROM poker_lobbies WHERE code=?", (code,))
        return ok(message="Lobby verlassen.")

    def finish(db, code, state, winner, message, reveal=False):
        hand = state["hand"]
        ensure_betting(hand)
        if winner is None:
            for pid, amount in hand["invested"].items():
                db.execute("UPDATE balances SET amount=amount+?,updated_at=? WHERE user_id=?", (amount, utc_now(), int(pid)))
        else:
            db.execute("UPDATE balances SET amount=amount+?,updated_at=? WHERE user_id=?", (hand["pot"], utc_now(), winner))
        for pid, invested in hand["invested"].items():
            player_id = int(pid)
            payout = invested if winner is None else hand["pot"] if player_id == winner else 0
            net = payout - invested
            balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (player_id,)).fetchone()["amount"]
            db.execute("""UPDATE player_stats SET rounds_played=rounds_played+1,wins=wins+?,losses=losses+?,pushes=pushes+?,
                highest_balance=MAX(highest_balance,?),biggest_win=MAX(biggest_win,?),
                total_won=total_won+?,total_lost=total_lost+? WHERE user_id=?""",
                (int(net > 0), int(net < 0), int(net == 0), balance, max(0, net), max(0, net), max(0, -net), player_id))
            record_big_win(db, player_id, "Poker", net, invested)
        hand["result"] = {"winnerId": winner, "message": message, "reveal": reveal}
        state["status"] = "finished"
        save(db, code, state)

    @app.post("/api/poker/start")
    @auth
    def poker_start():
        with transaction() as db:
            uid = g.auth["user_id"]
            member = membership(db, uid)
            if not member:
                raise ApiError(409, "Erstelle oder betrete zuerst eine Lobby.")
            code = member["lobby_code"]
            row, state = lobby(db, code)
            if row["host_id"] != uid:
                raise ApiError(403, "Nur der Host kann die Runde starten.")
            if state["status"] == "playing":
                raise ApiError(409, "Die Runde läuft bereits.")
            players = [r["user_id"] for r in db.execute("SELECT user_id FROM poker_members WHERE lobby_code=? ORDER BY joined_at,user_id", (code,))]
            if len(players) != 2:
                raise ApiError(409, "Für Poker werden zwei Spieler benötigt.")
            for pid in players:
                balance = db.execute("SELECT amount FROM balances WHERE user_id=?", (pid,)).fetchone()["amount"]
                if balance < ANTE:
                    raise ApiError(409, "Beide Spieler brauchen mindestens 10 Chips.")
                if (db.execute("SELECT 1 FROM active_rounds WHERE user_id=?", (pid,)).fetchone()
                        or db.execute("SELECT 1 FROM active_chicken_rounds WHERE user_id=?", (pid,)).fetchone()
                        or db.execute("SELECT 1 FROM crash_bets WHERE user_id=? AND payout IS NULL", (pid,)).fetchone()):
                    raise ApiError(409, "Ein Spieler muss zuerst seine laufende Runde beenden.")
            for pid in players:
                db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?", (ANTE, utc_now(), pid))
            deck = [rank + suit for rank in RANKS for suit in SUITS]
            secrets.SystemRandom().shuffle(deck)
            state = {"status": "playing", "name": state.get("name", f"Poker-Lobby {code}"), "hand": {
                "street": "preflop", "board": [deck.pop() for _ in range(5)],
                "cards": {str(pid): [deck.pop(), deck.pop()] for pid in players},
                "turn": players[0], "acted": [], "currentBet": 0,
                "contributions": {str(pid): 0 for pid in players},
                "invested": {str(pid): ANTE for pid in players}, "pot": 2 * ANTE,
            }}
            save(db, code, state)
            result = public(db, code, uid)
        return ok({"lobby": result}, "Runde gestartet.")

    @app.post("/api/poker/action")
    @auth
    def poker_action():
        payload = body()
        action = payload.get("action")
        if action not in ("draw", "call", "raise", "fold"):
            raise ApiError(400, "Ungültige Poker-Aktion.")
        with transaction() as db:
            uid = g.auth["user_id"]
            member = membership(db, uid)
            if not member:
                raise ApiError(409, "Du bist in keiner Poker-Lobby.")
            code = member["lobby_code"]
            _, state = lobby(db, code)
            if state["status"] != "playing":
                raise ApiError(409, "Es läuft keine Poker-Runde.")
            hand = state["hand"]
            if str(uid) not in hand["cards"]:
                raise ApiError(403, "Du spielst in dieser Runde nicht mit.")
            ensure_betting(hand)
            if hand["turn"] != uid:
                raise ApiError(409, "Der andere Spieler ist am Zug.")
            to_call, max_raise, balance, other = betting_limits(db, hand, uid)
            if action == "draw" and to_call:
                raise ApiError(409, "Gehe zuerst mit oder passe.")
            if action == "call" and not to_call:
                raise ApiError(409, "Es gibt keinen Einsatz zum Mitgehen.")
            amount = 0
            if action == "raise":
                try:
                    amount = float(payload.get("amount"))
                except (TypeError, ValueError):
                    amount = 0
                if not math.isfinite(amount) or amount < 5 or amount * 2 != round(amount * 2):
                    raise ApiError(400, "Erhöhe um mindestens 5 Chips in 0,5er-Schritten.")
                if amount > max_raise:
                    raise ApiError(409, "Die Erhöhung übersteigt die verfügbaren Chips am Tisch.")
            charge = to_call + amount if action in ("call", "raise") else 0
            if charge > balance:
                raise ApiError(409, "Nicht genügend Chips zum Mitgehen.")
            register_action(uid, payload.get("actionId"), "poker-" + action)
            if action == "fold":
                finish(db, code, state, other, "Ein Spieler hat gepasst.")
            else:
                if charge:
                    db.execute("UPDATE balances SET amount=amount-?,updated_at=? WHERE user_id=?", (charge, utc_now(), uid))
                    hand["contributions"][str(uid)] += charge
                    hand["invested"][str(uid)] += charge
                    hand["pot"] += charge
                if action == "raise":
                    hand["currentBet"] += amount
                    hand["acted"] = [uid]
                else:
                    hand["acted"].append(uid)
                if len(hand["acted"]) == 2:
                    index = STREETS.index(hand["street"])
                    if index == 3:
                        scores = {int(pid): best_hand(cards + hand["board"]) for pid, cards in hand["cards"].items()}
                        winner = max(scores, key=scores.get) if len(set(scores.values())) > 1 else None
                        winning_name = "Royal Flush" if winner is not None and scores[winner][:2] == (8, 14) else HAND_NAMES[scores[winner][0]] if winner is not None else ""
                        finish(db, code, state, winner, "Gleichstand: Alle Einsätze zurück." if winner is None else f"Showdown: {winning_name} gewinnt den Pot.", reveal=True)
                    else:
                        hand["street"] = STREETS[index + 1]
                        hand["currentBet"] = 0
                        hand["contributions"] = {pid: 0 for pid in hand["cards"]}
                        hand["acted"] = []
                        hand["turn"] = list(map(int, hand["cards"]))[(index + 1) % 2]
                        save(db, code, state)
                else:
                    hand["turn"] = other
                    save(db, code, state)
            result = public(db, code, uid)
        return ok({"lobby": result})
