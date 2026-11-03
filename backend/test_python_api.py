import os
from io import BytesIO
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TEMP_DB = Path(tempfile.gettempdir()) / "watt-casino-python-api-test.sqlite"
for suffix in ("", "-shm", "-wal"):
    TEMP_DB.with_name(TEMP_DB.name + suffix).unlink(missing_ok=True)
os.environ["DATABASE_PATH"] = str(TEMP_DB)
os.environ["NODE_ENV"] = "development"

from app import app, get_db, RATE_BUCKETS, outcome as determine_outcome, hand_value, blackjack as is_blackjack  # noqa: E402


class WattCasinoApiTests(unittest.TestCase):
    def test_poker_raise_limit_turn_and_fold_payout(self):
        tokens = [self.request("POST", "/api/auth/register", {"username": name, "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
                  for name in ("PokerRaiseHost", "PokerRaiseGuest")]
        self.request("POST", "/api/poker/create", {"name": "Raise Test Tisch"}, tokens[0])
        self.request("POST", "/api/poker/join", {"name": "Raise Test Tisch"}, tokens[1])
        self.request("POST", "/api/poker/start", {}, tokens[0])
        self.assertEqual(self.request("POST", "/api/slots/play", {"bet": 5, "actionId": "poker-other-game-0001"}, tokens[0]).status_code, 409)
        self.assertEqual(self.request("POST", "/api/poker/action", {"action": "fold", "actionId": "poker-wrong-turn-0001"}, tokens[1]).status_code, 409)
        self.assertEqual(self.request("POST", "/api/poker/action", {"action": "raise", "amount": 1000, "actionId": "poker-too-large-0001"}, tokens[0]).status_code, 409)
        raised = self.request("POST", "/api/poker/action", {"action": "raise", "amount": 5, "actionId": "poker-valid-raise-0001"}, tokens[0])
        self.assertEqual(raised.get_json()["data"]["lobby"]["hand"]["pot"], 25)
        self.assertEqual(raised.get_json()["data"]["lobby"]["hand"]["turnId"], raised.get_json()["data"]["lobby"]["players"][1]["id"])
        folded = self.request("POST", "/api/poker/action", {"action": "fold", "actionId": "poker-guest-fold-0001"}, tokens[1]).get_json()["data"]["lobby"]
        self.assertEqual(folded["status"], "finished")
        self.assertEqual(folded["hand"]["pot"], 25)
        balances = [self.request("GET", "/api/poker/current", token=token).get_json()["data"]["lobby"]["balance"] for token in tokens]
        self.assertEqual(balances, [1010, 990])
        with app.app_context():
            stats = [get_db().execute("SELECT rounds_played,wins,losses FROM player_stats WHERE user_id=(SELECT id FROM users WHERE username=?)", (name,)).fetchone()
                     for name in ("PokerRaiseHost", "PokerRaiseGuest")]
        self.assertEqual([tuple(row) for row in stats], [(1, 1, 0), (1, 0, 1)])

    def test_poker_tie_refunds_raises(self):
        tokens = [self.request("POST", "/api/auth/register", {"username": name, "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
                  for name in ("PokerTieHost", "PokerTieGuest")]
        self.request("POST", "/api/poker/create", {"name": "Tie Test Tisch"}, tokens[0])
        self.request("POST", "/api/poker/join", {"name": "Tie Test Tisch"}, tokens[1])
        self.request("POST", "/api/poker/start", {}, tokens[0])
        self.request("POST", "/api/poker/action", {"action": "raise", "amount": 20, "actionId": "poker-tie-raise-0001"}, tokens[0])
        self.request("POST", "/api/poker/action", {"action": "call", "actionId": "poker-tie-call-0001"}, tokens[1])
        for index, player in enumerate((1, 0, 0, 1, 1, 0)):
            if index == 5:
                with patch("poker.best_hand", return_value=(0, 14, 13, 12, 11, 9)):
                    result = self.request("POST", "/api/poker/action", {"action": "draw", "actionId": f"poker-tie-draw-{index:04d}"}, tokens[player])
            else:
                result = self.request("POST", "/api/poker/action", {"action": "draw", "actionId": f"poker-tie-draw-{index:04d}"}, tokens[player])
            self.assertEqual(result.status_code, 200)
        finished = result.get_json()["data"]["lobby"]
        self.assertIsNone(finished["hand"]["result"]["winnerId"])
        self.assertEqual(finished["hand"]["pot"], 60)
        balances = [self.request("GET", "/api/poker/current", token=token).get_json()["data"]["lobby"]["balance"] for token in tokens]
        self.assertEqual(balances, [1000, 1000])

    def test_local_frontend_cors_with_configured_origins(self):
        response = self.client.open("/api/auth/me", method="OPTIONS", headers={
            "Origin": "http://127.0.0.1:5501",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:5501")

    def test_poker_lobby_private_cards_and_showdown(self):
        tokens = [self.request("POST", "/api/auth/register", {"username": name, "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
                  for name in ("PokerHost", "PokerGuest")]
        created = self.request("POST", "/api/poker/create", {"name": "Freunde am Tisch"}, tokens[0])
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.get_json()["data"]["lobby"]["name"], "Freunde am Tisch")
        self.assertEqual(self.request("GET", "/api/poker/lobbies", token=tokens[1]).get_json()["data"]["lobbies"][0]["name"], "Freunde am Tisch")
        self.assertEqual(self.request("POST", "/api/poker/create", {"name": "freunde am tisch"}, tokens[1]).status_code, 409)
        self.assertEqual(self.request("POST", "/api/poker/join", {"name": "Fehlende Lobby"}, tokens[1]).status_code, 404)
        self.assertEqual(self.request("POST", "/api/poker/start", {}, tokens[0]).status_code, 409)
        self.assertEqual(self.request("POST", "/api/poker/join", {"name": "freunde am tisch"}, tokens[1]).status_code, 200)
        self.assertEqual(self.request("GET", "/api/poker/lobbies", token=tokens[0]).get_json()["data"]["lobbies"], [])
        self.assertEqual(self.request("POST", "/api/poker/start", {}, tokens[1]).status_code, 403)
        started = self.request("POST", "/api/poker/start", {}, tokens[0]).get_json()["data"]["lobby"]
        guest = self.request("GET", "/api/poker/current", token=tokens[1]).get_json()["data"]["lobby"]
        self.assertEqual(started["hand"]["board"], [])
        self.assertEqual(guest["hand"]["board"], [])
        self.assertEqual(len(started["hand"]["cards"]), 2)
        self.assertEqual(started["hand"]["opponentCards"], {})
        self.assertNotEqual(started["hand"]["cards"], guest["hand"]["cards"])
        self.assertEqual(started["balance"], 990)
        raised = self.request("POST", "/api/poker/action", {"action": "raise", "amount": 25, "actionId": "poker-raise-preflop-0001"}, tokens[0])
        self.assertEqual(raised.status_code, 200)
        self.assertEqual(raised.get_json()["data"]["lobby"]["hand"]["pot"], 45)
        self.assertEqual(self.request("POST", "/api/poker/action", {"action": "draw", "actionId": "poker-draw-blocked-0001"}, tokens[1]).status_code, 409)
        called = self.request("POST", "/api/poker/action", {"action": "call", "actionId": "poker-call-preflop-0001"}, tokens[1]).get_json()["data"]["lobby"]
        self.assertEqual(called["hand"]["pot"], 70)
        self.assertEqual(called["hand"]["street"], "flop")
        self.assertEqual(len(called["hand"]["board"]), 3)
        self.assertEqual(called["balance"], 965)
        for index, (street, visible) in enumerate((("turn", 4), ("river", 5))):
            first, second = (tokens[1], tokens[0]) if index == 0 else (tokens[0], tokens[1])
            self.assertEqual(self.request("POST", "/api/poker/action", {"action": "draw", "actionId": f"poker-draw-first-{index:04d}"}, first).status_code, 200)
            self.assertEqual(self.request("POST", "/api/poker/action", {"action": "draw", "actionId": f"poker-draw-repeat-{index:04d}"}, first).status_code, 409)
            data = self.request("POST", "/api/poker/action", {"action": "draw", "actionId": f"poker-draw-second-{index:04d}"}, second).get_json()["data"]["lobby"]
            self.assertEqual(data["hand"]["street"], street)
            self.assertEqual(len(data["hand"]["board"]), visible)
        self.request("POST", "/api/poker/action", {"action": "draw", "actionId": "poker-river-first-0001"}, tokens[1])
        finished = self.request("POST", "/api/poker/action", {"action": "draw", "actionId": "poker-river-second-0001"}, tokens[0]).get_json()["data"]["lobby"]
        self.assertEqual(finished["status"], "finished")
        self.assertEqual(len(finished["hand"]["opponentCards"]), 1)
        balances = [self.request("GET", "/api/poker/current", token=token).get_json()["data"]["lobby"]["balance"] for token in tokens]
        self.assertEqual(sum(balances), 2000)
        self.assertEqual(self.request("POST", "/api/poker/leave", {}, tokens[1]).status_code, 200)
        self.assertIsNone(self.request("GET", "/api/poker/current", token=tokens[1]).get_json()["data"]["lobby"])

    def test_loot_rewards_history_and_duplicate_open(self):
        token = self.request("POST", "/api/auth/register", {"username": "LootPlayer", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        catalog = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(catalog["catalogVersion"], 2)
        self.assertEqual([box["price"] for box in catalog["boxes"]], [66, 273.5, 318, 27508])
        with app.app_context():
            get_db().execute("UPDATE balances SET amount=100000 WHERE user_id=(SELECT id FROM users WHERE username='LootPlayer')")
        balance = 100000
        for index, box in enumerate(catalog["boxes"]):
            self.assertEqual(sum(item["chance"] for item in box["rewards"]), 100)
            payload = {"box": box["key"], "price": 0, "payout": 999999, "actionId": f"loot-open-test-{index:04d}"}
            with patch("app.secrets.randbelow", return_value=99):
                response = self.request("POST", "/api/loot/open", payload, token)
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            balance -= box["price"]
            self.assertEqual(data["item"]["key"], box["rewards"][-1]["key"])
            self.assertNotIn("payout", data)
            self.assertEqual(data["balance"], balance)
            self.assertEqual(self.request("POST", "/api/loot/open", payload, token).status_code, 409)
        resumed = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(len(resumed["history"]), 4)
        self.assertEqual(resumed["balance"], balance)
        for key in ("bronze", "emerald", "royal", "unknown"):
            self.assertEqual(self.request("POST", "/api/loot/open", {"box": key, "actionId": "invalid-box-" + key}, token).status_code, 400)
        with app.app_context():
            get_db().execute("UPDATE balances SET amount=10 WHERE user_id=(SELECT id FROM users WHERE username='LootPlayer')")
        self.assertEqual(self.request("POST", "/api/loot/open", {"box": "audio", "actionId": "loot-poor-player-0001"}, token).status_code, 400)
        self.assertEqual(self.request("GET", "/api/loot/current", token=token).get_json()["data"]["balance"], 10)

    def test_tech_pack_inventory_is_persistent_and_duplicate_safe(self):
        token = self.request("POST", "/api/auth/register", {"username": "TechCollector", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        catalog = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        rewards = next(box for box in catalog["boxes"] if box["key"] == "tech")["rewards"]
        self.assertEqual(sum(item["chance"] for item in rewards), 100)
        with app.app_context():
            get_db().execute("UPDATE balances SET amount=10000 WHERE user_id=(SELECT id FROM users WHERE username='TechCollector')")
        for index, roll in enumerate((39, 40, 65, 85, 95, 99)):
            payload = {"box": "tech", "item": "iphone-pro", "price": 0, "actionId": f"tech-pack-open-{index:04d}"}
            with patch("app.secrets.randbelow", return_value=roll):
                response = self.request("POST", "/api/loot/open", payload, token)
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            self.assertEqual(data["item"]["key"], rewards[index]["key"])
            self.assertEqual(sum(entry["quantity"] for entry in data["inventory"]), index+1)
            self.assertNotIn("payout", data)
            self.assertEqual(self.request("POST", "/api/loot/open", payload, token).status_code, 409)
        resumed = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(len(resumed["inventory"]), 6)
        self.assertEqual(resumed["history"][0]["item_key"], "iphone-pro")
        self.assertEqual(resumed["balance"], 8092)

    def test_shared_crash_round_cashout_loss_and_reload(self):
        tokens = [self.request("POST", "/api/auth/register", {"username": name, "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
                  for name in ("CrashPlayerOne", "CrashPlayerTwo")]
        with app.app_context():
            db = get_db()
            db.execute("DELETE FROM crash_bets")
            db.execute("DELETE FROM crash_rounds")
        with patch("app.time.time", return_value=1000), patch("app.secrets.randbelow", return_value=499999):
            first = self.request("GET", "/api/crash/current", token=tokens[0]).get_json()["data"]
            second = self.request("GET", "/api/crash/current", token=tokens[1]).get_json()["data"]
        self.assertEqual(first["round"], second["round"])
        self.assertEqual(first["round"]["phase"], "waiting")
        self.assertNotIn("crash_at", first["round"])
        self.assertNotIn("ends_at", first["round"])
        round_id = first["round"]["id"]
        with patch("app.time.time", return_value=1001):
            for index, token in enumerate(tokens):
                response = self.request("POST", "/api/crash/bet", {"roundId": round_id, "bet": 100 if index == 0 else 1000, "actionId": f"crash-bet-action-{index:04d}"}, token)
                self.assertEqual(response.status_code, 200)
            resumed = self.request("GET", "/api/crash/current", token=tokens[1]).get_json()["data"]
            self.assertEqual(resumed["balance"], 0)
            self.assertEqual(resumed["mine"]["bet"], 1000)
            self.assertEqual(len(resumed["players"]), 2)
            blocked = self.request("POST", "/api/pinball/play", {"bet": 5, "actionId": "crash-other-game-block"}, tokens[0])
            self.assertEqual(blocked.status_code, 409)
        with patch("app.time.time", return_value=1011):
            response = self.request("POST", "/api/crash/cashout", {"roundId": round_id, "actionId": "crash-cashout-action-1"}, tokens[0])
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            self.assertEqual(data["mine"]["payout"], 130)
            self.assertEqual(data["balance"], 1030)
            duplicate = self.request("POST", "/api/crash/cashout", {"roundId": round_id, "actionId": "crash-cashout-action-2"}, tokens[0])
            self.assertEqual(duplicate.status_code, 409)
        with patch("app.time.time", return_value=1016):
            result = self.request("GET", "/api/crash/current", token=tokens[1]).get_json()["data"]
            self.assertEqual(result["round"]["phase"], "crashed")
            self.assertEqual(result["round"]["multiplier"], 1.98)
            self.assertEqual(result["mine"]["net"], -1000)
            self.assertEqual(result["balance"], 1000)
            again = self.request("GET", "/api/crash/current", token=tokens[1]).get_json()["data"]
            self.assertEqual(again["balance"], 1000)
            self.assertEqual(result["history"][0]["id"], round_id)
        with patch("app.time.time", return_value=1022):
            next_round = self.request("GET", "/api/crash/current", token=tokens[0]).get_json()["data"]
            self.assertNotEqual(next_round["round"]["id"], round_id)
            self.assertEqual(len(next_round["previous"]), 2)
            stale = self.request("POST", "/api/crash/bet", {"roundId": round_id, "bet": 5, "actionId": "crash-stale-round-bet"}, tokens[0])
            self.assertEqual(stale.status_code, 409)

    def setUp(self):
        self.client = app.test_client()
        RATE_BUCKETS.clear()
        WattCasinoApiTests._ip_sequence = getattr(WattCasinoApiTests, "_ip_sequence", 0) + 1
        self.remote_addr = f"198.18.0.{WattCasinoApiTests._ip_sequence}"

    def request(self, method, path, payload=None, token=None, ip=None, real_ip=None):
        headers = {"Origin": "http://127.0.0.1:8080"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if real_ip:
            headers["X-Real-IP"] = real_ip
        return self.client.open(path, method=method, json=payload, headers=headers, environ_overrides={"REMOTE_ADDR": ip or self.remote_addr})

    def admin_token(self):
        credentials = {"username": "Tiago", "password": "SicheresTestpasswort9"}
        response = self.request("POST", "/api/auth/register", credentials)
        if response.status_code == 409:
            response = self.request("POST", "/api/auth/login", credentials)
        return response.get_json()["data"]["token"]

    @staticmethod
    def non_terminal_shoe():
        card = lambda rank: {"rank": rank, "suit": "♠"}
        # draw() nimmt vom Ende: Spieler 10/7, Dealer 9/8.
        return [card("2"), card("3"), card("8"), card("9"), card("7"), card("10")]

    def test_zero_balance_is_restored_on_next_request(self):
        player = {"username": "EmptyPlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]
        with app.app_context():
            db = get_db()
            db.execute("UPDATE balances SET amount=0 WHERE user_id=(SELECT id FROM users WHERE username=?)", (player["username"],))
        me = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.get_json()["data"]["game"]["balance"], 1000)
        again = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(again.get_json()["data"]["game"]["balance"], 1000)

        with patch("app.create_shoe", side_effect=self.non_terminal_shoe):
            started = self.request("POST", "/api/game/start", {"bet": 1000, "actionId": "empty-all-in-action-0001"}, token)
        self.assertEqual(started.status_code, 201)
        in_round = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(in_round.get_json()["data"]["game"]["balance"], 0)

    def test_chicken_round_survives_reload_and_cashout(self):
        player = {"username": "ChickenPlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]
        started = self.request("POST", "/api/chicken/start", {"bet": 1000, "actionId": "chicken-start-action-0001"}, token)
        self.assertEqual(started.status_code, 201)
        self.assertEqual(started.get_json()["data"]["balance"], 0)
        current = self.request("GET", "/api/chicken/current", token=token)
        self.assertEqual(current.get_json()["data"]["balance"], 0)
        self.assertEqual(current.get_json()["data"]["round"]["steps"], 0)
        with patch("app.secrets.randbelow", return_value=0):
            step = self.request("POST", "/api/chicken/step", {"actionId": "chicken-step-action-0001"}, token)
        self.assertEqual(step.get_json()["data"]["round"]["steps"], 1)
        self.assertEqual(step.get_json()["data"]["round"]["payout"], 800)
        duplicate = self.request("POST", "/api/chicken/step", {"actionId": "chicken-step-action-0001"}, token)
        self.assertEqual(duplicate.status_code, 409)
        cashed = self.request("POST", "/api/chicken/cashout", {"actionId": "chicken-cashout-action-0001"}, token)
        self.assertEqual(cashed.get_json()["data"]["balance"], 800)
        self.assertIsNone(cashed.get_json()["data"]["round"])

        started = self.request("POST", "/api/chicken/start", {"bet": 800, "actionId": "chicken-start-action-0002"}, token)
        self.assertEqual(started.status_code, 201)
        with patch("app.secrets.randbelow", return_value=99):
            lost = self.request("POST", "/api/chicken/step", {"actionId": "chicken-step-action-0002"}, token)
        self.assertFalse(lost.get_json()["data"]["result"]["won"])
        self.assertEqual(lost.get_json()["data"]["balance"], 1000)
        self.request("POST", "/api/chicken/start", {"bet": 5, "actionId": "chicken-ten-start-0001"}, token)
        with patch("app.secrets.randbelow", return_value=0):
            for step_number in range(1, 10):
                response = self.request("POST", "/api/chicken/step", {"actionId": f"chicken-ten-step-{step_number:04d}"}, token)
                self.assertEqual(response.status_code, 200)
                data = response.get_json()["data"]
                if step_number < 9:
                    self.assertEqual(data["round"]["steps"], step_number)
                    if step_number <= 3:
                        self.assertEqual(data["round"]["payout"], (4, 5, 12)[step_number - 1])
                else:
                    self.assertIsNone(data["round"])
                    self.assertEqual(data["result"]["steps"], 9)
                    self.assertEqual(data["result"]["payout"], 47.5)
                    self.assertEqual(data["balance"], 1042.5)

    def test_auth_game_admin_and_suspension(self):
        player = {"username": "PythonPlayer", "password": "SicheresTestpasswort9"}
        registered = self.request("POST", "/api/auth/register", player)
        self.assertEqual(registered.status_code, 201)
        token = registered.get_json()["data"]["token"]

        me = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.get_json()["data"]["user"]["balance"], 1000)

        with patch("app.create_shoe", side_effect=self.non_terminal_shoe):
            game = self.request("POST", "/api/game/start", {"bet": 25, "actionId": "python-start-action-0001"}, token)
        self.assertEqual(game.status_code, 201)
        self.assertTrue(game.get_json()["success"])

        # Das Frontend benötigt beim erneuten Laden nur noch diesen einen Abruf
        # für Profil, Guthaben und die laufende Runde.
        resumed = self.request("GET", "/api/auth/me", token=token)
        resumed_data = resumed.get_json()["data"]
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed_data["game"]["round"]["id"], game.get_json()["data"]["round"]["id"])
        self.assertEqual(resumed_data["game"]["balance"], 975)

        admin_token = self.admin_token()
        players = self.request("GET", "/api/admin/players", token=admin_token).get_json()["data"]["players"]
        player_id = next(row["id"] for row in players if row["username"] == "PythonPlayer")

        suspended = self.request(
            "PATCH",
            f"/api/admin/players/{player_id}/suspension",
            {"suspended": True, "reason": "Test-Sperre"},
            admin_token,
        )
        self.assertEqual(suspended.status_code, 200)

        blocked_login = self.request("POST", "/api/auth/login", player)
        self.assertEqual(blocked_login.status_code, 403)
        self.assertTrue(blocked_login.get_json()["data"]["suspended"])
        self.assertEqual(blocked_login.get_json()["data"]["reason"], "Test-Sperre")

        blocked_session = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(blocked_session.status_code, 403)

        preflight = self.client.open(
            "/api/auth/login",
            method="OPTIONS",
            headers={"Origin": "http://127.0.0.1:8080", "Access-Control-Request-Method": "POST"},
        )
        self.assertEqual(preflight.status_code, 204)
        self.assertEqual(preflight.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:8080")

    def test_moderator_permissions_and_immediate_revocation(self):
        owner = self.admin_token()
        moderator = self.request("POST", "/api/auth/register", {"username": "ModRights", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        target = self.request("POST", "/api/auth/register", {"username": "ModTarget", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        self.assertEqual(self.request("POST", "/api/admin/login", {"password": "2011"}).status_code, 404)
        self.assertEqual(self.request("GET", "/api/admin/players", token=moderator).status_code, 403)
        granted = self.request("PUT", "/api/admin/moderators/ModRights", {"permissions": ["view_players", "suspend_players"]}, owner)
        self.assertEqual(granted.status_code, 200)
        self.assertEqual(self.request("GET", "/api/admin/me", token=moderator).get_json()["data"]["role"], "moderator")
        self.assertEqual(self.request("GET", "/api/admin/players", token=moderator).status_code, 200)
        self.assertEqual(self.request("GET", "/api/admin/moderators", token=moderator).status_code, 403)
        with app.app_context():
            target_id = get_db().execute("SELECT id FROM users WHERE username='ModTarget'").fetchone()["id"]
            owner_id = get_db().execute("SELECT id FROM users WHERE username_normalized='tiago'").fetchone()["id"]
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{target_id}/balance", {"amount": 5000}, moderator).status_code, 403)
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{target_id}/username", {"username": "NewTarget"}, moderator).status_code, 403)
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{owner_id}/suspension", {"suspended": True, "reason": "Test"}, moderator).status_code, 403)
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{target_id}/suspension", {"suspended": True, "reason": "Test"}, moderator).status_code, 200)
        self.assertEqual(self.request("GET", "/api/auth/me", token=target).status_code, 403)
        self.assertEqual(self.request("DELETE", "/api/admin/moderators/ModRights", token=owner).status_code, 200)
        self.assertEqual(self.request("GET", "/api/admin/players", token=moderator).status_code, 403)

    def test_leaderboard_ties_have_unique_ranks_matching_profiles(self):
        credentials = {"password": "SicheresTestpasswort9"}
        first = self.request("POST", "/api/auth/register", {**credentials, "username": "TieAlpha"}).get_json()["data"]["token"]
        self.request("POST", "/api/auth/register", {**credentials, "username": "TieBeta"})
        players = self.request("GET", "/api/leaderboard?limit=100", token=first).get_json()["data"]["players"]
        ranks = [player["rank"] for player in players]
        self.assertEqual(ranks, list(range(1, len(players) + 1)))
        alpha = next(player for player in players if player["username"] == "TieAlpha")
        beta = next(player for player in players if player["username"] == "TieBeta")
        self.assertEqual(alpha["balance"], beta["balance"])
        self.assertLess(alpha["rank"], beta["rank"])
        for player in (alpha, beta):
            profile = self.request("GET", f"/api/players/{player['username']}", token=first).get_json()["data"]["player"]
            self.assertEqual(profile["rank"], player["rank"])

    def test_moderator_can_manage_only_own_balance(self):
        owner = self.admin_token()
        moderator = self.request("POST", "/api/auth/register", {"username": "OwnMoneyMod", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        self.request("POST", "/api/auth/register", {"username": "OtherMoney", "password": "SicheresTestpasswort9"})
        self.assertEqual(self.request("PUT", "/api/admin/moderators/OwnMoneyMod", {"permissions": ["change_balance"]}, owner).status_code, 400)
        self.assertEqual(self.request("PUT", "/api/admin/moderators/OwnMoneyMod", {"permissions": ["change_own_balance"]}, owner).status_code, 200)
        access = self.request("GET", "/api/admin/me", token=moderator).get_json()["data"]
        self.assertEqual(access["permissions"], ["change_own_balance"])
        listing = self.request("GET", "/api/admin/players?search=OtherMoney", token=moderator).get_json()["data"]
        self.assertEqual([player["username"] for player in listing["players"]], ["OwnMoneyMod"])
        with app.app_context():
            other_id = get_db().execute("SELECT id FROM users WHERE username='OtherMoney'").fetchone()["id"]
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{other_id}/balance", {"amount": 5000}, moderator).status_code, 403)
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{access['userId']}/balance", {"amount": 1500}, moderator).status_code, 200)
        self.assertEqual(self.request("GET", "/api/admin/players", token=moderator).get_json()["data"]["players"][0]["balance"], 1500)
        results = self.request("GET", "/api/admin/users?search=OwnMoney", token=owner).get_json()["data"]["users"]
        self.assertEqual(results[0]["username"], "OwnMoneyMod")
        self.assertEqual(self.request("GET", "/api/admin/users?search=OwnMoney", token=moderator).status_code, 403)

    def test_suspension_bans_known_ips_and_blocks_new_accounts(self):
        owner = self.admin_token()
        credentials = {"username": "BannedPlayer", "password": "SicheresTestpasswort9"}
        banned_ip = "203.0.113.10"
        second_ip = "203.0.113.11"
        token = self.request("POST", "/api/auth/register", credentials, ip=banned_ip).get_json()["data"]["token"]
        other = {"username": "SafePlayer", "password": "SicheresTestpasswort9"}
        self.request("POST", "/api/auth/register", other, ip=second_ip)
        with app.app_context():
            user_id = get_db().execute("SELECT id FROM users WHERE username='BannedPlayer'").fetchone()["id"]
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{user_id}/suspension", {"suspended": True, "reason": "Regelverstoss"}, owner).status_code, 200)
        self.assertEqual(self.request("GET", "/api/auth/me", token=token, ip=banned_ip).status_code, 403)
        self.assertEqual(self.request("POST", "/api/auth/register", {"username": "BanEvasion", "password": "SicheresTestpasswort9"}, ip=banned_ip).status_code, 403)
        self.assertEqual(self.request("POST", "/api/auth/login", other, ip=banned_ip).status_code, 403)
        self.assertEqual(self.request("POST", "/api/auth/login", other, ip=second_ip).status_code, 200)
        self.assertEqual(self.request("POST", "/api/auth/login", credentials, ip="203.0.113.12").status_code, 403)
        self.assertEqual(self.request("POST", "/api/auth/register", {"username": "AnotherEvasion", "password": "SicheresTestpasswort9"}, ip="203.0.113.12").status_code, 403)
        self.assertEqual(self.request("PATCH", f"/api/admin/players/{user_id}/suspension", {"suspended": False}, owner).status_code, 200)
        self.assertEqual(self.request("POST", "/api/auth/login", credentials, ip=banned_ip).status_code, 200)

    def test_pythonanywhere_uses_real_ip_header_for_bans(self):
        owner = self.admin_token()
        with patch.dict(os.environ, {"NODE_ENV": "production"}):
            registered = self.request("POST", "/api/auth/register", {"username": "ProxyBanned", "password": "SicheresTestpasswort9"}, ip="10.0.0.1", real_ip="203.0.113.30")
            self.assertEqual(registered.status_code, 201)
            with app.app_context():
                user_id = get_db().execute("SELECT id FROM users WHERE username='ProxyBanned'").fetchone()["id"]
            self.assertEqual(self.request("PATCH", f"/api/admin/players/{user_id}/suspension", {"suspended": True, "reason": "Test"}, owner).status_code, 200)
            self.assertEqual(self.request("POST", "/api/auth/register", {"username": "ProxyEvasion", "password": "SicheresTestpasswort9"}, ip="10.0.0.2", real_ip="203.0.113.30").status_code, 403)
            self.assertEqual(self.request("POST", "/api/auth/register", {"username": "ProxySafe", "password": "SicheresTestpasswort9"}, ip="10.0.0.1", real_ip="203.0.113.31").status_code, 201)

    def test_pinball_uses_published_probabilities_and_varied_slots(self):
        token = self.request("POST", "/api/auth/register", {"username": "PinballOdds", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        config = self.request("GET", "/api/pinball/config", token=token).get_json()["data"]
        weights = config["slotWeights"]
        self.assertEqual(len(weights), len(config["multipliers"]))
        self.assertEqual(sum(weights), config["totalWeight"])
        self.assertEqual(weights, [100, 200, 400, 700, 1200, 1400, 2000, 1400, 1200, 700, 400, 200, 100])
        self.assertEqual(weights[5] / config["totalWeight"], 0.14)
        self.assertEqual(config["multipliers"][6], 0.3)
        self.assertEqual(weights[6] / config["totalWeight"], 0.20)
        self.assertEqual(weights[7] / config["totalWeight"], 0.14)
        self.assertEqual(sum(weight for weight, multiplier in zip(weights, config["multipliers"]) if multiplier > 1) / config["totalWeight"], 0.52)
        expected_return = sum(weight * multiplier for weight, multiplier in zip(weights, config["multipliers"])) / config["totalWeight"]
        self.assertAlmostEqual(expected_return, 9.068)
        for index, (roll, expected_slot) in enumerate(((0, 0), (1400, 4), (2600, 5), (4000, 6), (9999, 12))):
            with patch("app.secrets.randbelow", return_value=roll):
                response = self.request("POST", "/api/pinball/play", {"bet": 5, "actionId": f"pinball-odds-roll-{index:04d}"}, token)
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            self.assertEqual(data["slot"], expected_slot)
            self.assertEqual(data["multiplier"], config["multipliers"][expected_slot])
            if expected_slot == 6:
                self.assertEqual(data["payout"], 1.5)
            self.assertEqual(data["slotWeights"], weights)
            self.assertEqual(sum(data["path"]), expected_slot)

    def test_owner_can_delete_player_and_cascade_account_data(self):
        owner = self.admin_token()
        credentials = {"username": "DeleteTarget", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", credentials).get_json()["data"]["token"]
        with app.app_context():
            db = get_db()
            player_id = db.execute("SELECT id FROM users WHERE username='DeleteTarget'").fetchone()["id"]
            owner_id = db.execute("SELECT id FROM users WHERE username_normalized='tiago'").fetchone()["id"]
            db.execute("INSERT INTO market_trades (item_key,seller_id,buyer_id,price,at) VALUES (?,?,?,?,?)",("demo",player_id,owner_id,1,1))
        self.assertEqual(self.request("POST", "/api/poker/create", {"name": "Delete Test Tisch"}, token).status_code, 201)
        self.assertEqual(self.request("POST", "/api/poker/join", {"name": "Delete Test Tisch"}, owner).status_code, 200)
        self.assertEqual(self.request("POST", "/api/poker/start", {}, token).status_code, 200)
        self.assertEqual(self.request("GET", "/api/auth/me", token=owner).get_json()["data"]["game"]["balance"], 990)
        endpoint = f"/api/admin/players/{player_id}"
        self.assertEqual(self.request("DELETE", endpoint, {"confirmUsername": "wrong"}, owner).status_code, 400)
        self.assertEqual(self.request("DELETE", f"/api/admin/players/{owner_id}", {"confirmUsername": "Tiago"}, owner).status_code, 403)
        self.assertEqual(self.request("DELETE", endpoint, {"confirmUsername": "DeleteTarget"}, token).status_code, 403)
        self.assertEqual(self.request("DELETE", endpoint, {"confirmUsername": "DeleteTarget"}, owner).status_code, 200)
        self.assertEqual(self.request("GET", "/api/auth/me", token=token).status_code, 401)
        self.assertEqual(self.request("GET", "/api/players/DeleteTarget", token=owner).status_code, 404)
        self.assertIsNone(self.request("GET", "/api/poker/current", token=owner).get_json()["data"]["lobby"])
        self.assertEqual(self.request("GET", "/api/auth/me", token=owner).get_json()["data"]["game"]["balance"], 1000)
        with app.app_context():
            db = get_db()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM market_trades WHERE seller_id=? OR buyer_id=?",(player_id,player_id)).fetchone()[0],0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM user_ips WHERE user_id=?",(player_id,)).fetchone()[0],0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(),[])

    def test_avatar_upload_is_saved_and_publicly_served(self):
        player = {"username": "AvatarPlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]
        response = self.client.post(
            "/api/profile/avatar",
            data={"avatar": (BytesIO(b"\x89PNG\r\n\x1a\nminimal"), "avatar.png")},
            content_type="multipart/form-data",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(response.status_code, 200)
        avatar_url = response.get_json()["data"]["avatarUrl"]
        self.assertEqual(self.request("GET", "/api/auth/me", token=token).get_json()["data"]["user"]["avatarUrl"], avatar_url)
        avatar_response = self.client.get(avatar_url)
        self.assertEqual(avatar_response.status_code, 200)
        avatar_response.close()

    def test_blackjack_rules_match_the_browser_game(self):
        card = lambda rank, suit="♠": {"rank": rank, "suit": suit}
        self.assertEqual(hand_value([card("A"), card("A"), card("9")]), 21)
        self.assertEqual(hand_value([card("A"), card("A"), card("9"), card("K")]), 21)
        self.assertEqual(hand_value([card("A"), card("6"), card("K")]), 17)
        self.assertTrue(is_blackjack([card("A"), card("K")]))
        self.assertFalse(is_blackjack([card("A"), card("5"), card("5")]))
        self.assertEqual(determine_outcome([card("A"), card("K")], [card("10"), card("9")]), "blackjack")
        self.assertEqual(determine_outcome([card("K"), card("Q"), card("2")], [card("10"), card("7")]), "loss")
        self.assertEqual(determine_outcome([card("10"), card("8")], [card("K"), card("8")]), "push")

    def test_upgrades_purchase_daily_claim_and_active_round_lock(self):
        player = {"username": "UpgradePlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]

        initial = self.request("GET", "/api/upgrades", token=token)
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(len(initial.get_json()["data"]["upgrades"]), 7)
        self.assertFalse(initial.get_json()["data"]["dailyBonus"]["available"])

        bought = self.request(
            "POST",
            "/api/upgrades/daily_bonus/buy",
            {"actionId": "upgrade-daily-buy-0001"},
            token,
        )
        self.assertEqual(bought.status_code, 200)
        bought_data = bought.get_json()["data"]
        daily = next(item for item in bought_data["upgrades"] if item["key"] == "daily_bonus")
        self.assertEqual(daily["level"], 1)
        self.assertEqual(bought_data["balance"], 500)
        self.assertTrue(bought_data["dailyBonus"]["available"])

        duplicate_buy = self.request(
            "POST",
            "/api/upgrades/daily_bonus/buy",
            {"actionId": "upgrade-daily-buy-0001"},
            token,
        )
        self.assertEqual(duplicate_buy.status_code, 409)

        claimed = self.request(
            "POST",
            "/api/upgrades/daily-bonus/claim",
            {"actionId": "upgrade-daily-claim-01"},
            token,
        )
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(claimed.get_json()["data"]["balance"], 550)
        self.assertFalse(claimed.get_json()["data"]["dailyBonus"]["available"])

        claimed_again = self.request(
            "POST",
            "/api/upgrades/daily-bonus/claim",
            {"actionId": "upgrade-daily-claim-02"},
            token,
        )
        self.assertEqual(claimed_again.status_code, 409)

        with patch("app.create_shoe", side_effect=self.non_terminal_shoe):
            started = self.request(
                "POST",
                "/api/game/start",
                {"bet": 5, "actionId": "upgrade-round-start-01"},
                token,
            )
        self.assertEqual(started.status_code, 201)
        blocked = self.request(
            "POST",
            "/api/upgrades/starting_capital/buy",
            {"actionId": "upgrade-blocked-buy-01"},
            token,
        )
        self.assertEqual(blocked.status_code, 409)

    def test_starting_capital_upgrade_changes_refill_amount(self):
        player = {"username": "CapitalPlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]
        bought = self.request(
            "POST",
            "/api/upgrades/starting_capital/buy",
            {"actionId": "capital-upgrade-buy-001"},
            token,
        )
        self.assertEqual(bought.status_code, 200)
        self.assertEqual(bought.get_json()["data"]["balance"], 250)

        card = lambda rank: {"rank": rank, "suit": "♠"}
        losing_shoe = [card("2"), card("3"), card("10"), card("10"), card("7"), card("10")]
        with patch("app.create_shoe", return_value=losing_shoe):
            started = self.request(
                "POST",
                "/api/game/start",
                {"bet": 250, "actionId": "capital-round-start-001"},
                token,
            )
        self.assertEqual(started.status_code, 201)
        finished = self.request(
            "POST",
            "/api/game/stand",
            {"actionId": "capital-round-stand-001"},
            token,
        )
        self.assertEqual(finished.status_code, 200)
        self.assertEqual(finished.get_json()["data"]["round"]["result"]["outcome"], "loss")
        self.assertEqual(finished.get_json()["data"]["balance"], 1250)

    def test_luck_can_rescue_only_once_per_round(self):
        player = {"username": "LuckyPlayer", "password": "SicheresTestpasswort9"}
        token = self.request("POST", "/api/auth/register", player).get_json()["data"]["token"]
        admin_token = self.admin_token()
        players = self.request("GET", "/api/admin/players", token=admin_token).get_json()["data"]["players"]
        player_id = next(row["id"] for row in players if row["username"] == "LuckyPlayer")
        funded = self.request(
            "PATCH",
            f"/api/admin/players/{player_id}/balance",
            {"amount": 5000, "reason": "Upgrade-Test"},
            admin_token,
        )
        self.assertEqual(funded.status_code, 200)
        bought = self.request(
            "POST",
            "/api/upgrades/luck/buy",
            {"actionId": "luck-upgrade-buy-00001"},
            token,
        )
        self.assertEqual(bought.status_code, 200)

        card = lambda rank: {"rank": rank, "suit": "♠"}
        # Spieler 10/6, Dealer 10/7, danach K (Bust), 4 (Rettung), 3 (zweiter Bust).
        lucky_shoe = [card("2"), card("3"), card("4"), card("K"), card("7"), card("10"), card("6"), card("10")]
        with patch("app.create_shoe", return_value=lucky_shoe):
            started = self.request(
                "POST",
                "/api/game/start",
                {"bet": 10, "actionId": "luck-round-start-0001"},
                token,
            )
        self.assertEqual(started.status_code, 201)
        with patch("app.secrets.randbelow", return_value=0):
            rescued = self.request(
                "POST",
                "/api/game/hit",
                {"actionId": "luck-round-first-hit-01"},
                token,
            )
        rescued_round = rescued.get_json()["data"]["round"]
        self.assertEqual(rescued.status_code, 200)
        self.assertEqual(rescued_round["status"], "active")
        self.assertEqual(rescued_round["playerValue"], 20)
        self.assertIn("Glück", rescued_round["notice"])

        with patch("app.secrets.randbelow", return_value=0):
            second_hit = self.request(
                "POST",
                "/api/game/hit",
                {"actionId": "luck-round-second-hit-1"},
                token,
            )
        self.assertEqual(second_hit.status_code, 200)
        self.assertEqual(second_hit.get_json()["data"]["round"]["result"]["outcome"], "loss")


if __name__ == "__main__":
    unittest.main()
