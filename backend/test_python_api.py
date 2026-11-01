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
os.environ["ADMIN_PASSWORD"] = "2011"

from app import app, get_db, outcome as determine_outcome, hand_value, blackjack as is_blackjack  # noqa: E402


class WattCasinoApiTests(unittest.TestCase):
    def test_loot_rewards_history_and_duplicate_open(self):
        token = self.request("POST", "/api/auth/register", {"username": "LootPlayer", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        catalog = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(sum(reward["chance"] for reward in catalog["rewards"]), 100)
        self.assertEqual([box["price"] for box in catalog["boxes"] if box.get("kind") != "items"], [50, 250, 1000])
        balance = 1000
        for index, (roll, payout) in enumerate(((39, 12.5), (40, 25), (65, 50), (85, 100), (95, 250), (99, 500))):
            payload = {"box": "bronze", "price": 0, "payout": 999999, "actionId": f"loot-open-test-{index:04d}"}
            with patch("app.secrets.randbelow", return_value=roll):
                response = self.request("POST", "/api/loot/open", payload, token)
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            balance += payout - 50
            self.assertEqual(data["rewardIndex"], index)
            self.assertEqual(data["payout"], payout)
            self.assertEqual(data["balance"], balance)
            duplicate = self.request("POST", "/api/loot/open", payload, token)
            self.assertEqual(duplicate.status_code, 409)
        resumed = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(len(resumed["history"]), 6)
        self.assertEqual(resumed["balance"], balance)
        invalid = self.request("POST", "/api/loot/open", {"box": "unknown", "actionId": "loot-invalid-box-0001"}, token)
        self.assertEqual(invalid.status_code, 400)
        with app.app_context():
            get_db().execute("UPDATE balances SET amount=10 WHERE user_id=(SELECT id FROM users WHERE username='LootPlayer')")
        poor = self.request("POST", "/api/loot/open", {"box": "royal", "actionId": "loot-poor-player-0001"}, token)
        self.assertEqual(poor.status_code, 400)
        self.assertEqual(self.request("GET", "/api/loot/current", token=token).get_json()["data"]["balance"], 10)

    def test_tech_pack_inventory_is_persistent_and_duplicate_safe(self):
        token = self.request("POST", "/api/auth/register", {"username": "TechCollector", "password": "SicheresTestpasswort9"}).get_json()["data"]["token"]
        catalog = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(sum(item["chance"] for item in catalog["items"]), 100)
        for index, roll in enumerate((39, 40, 65, 85, 95, 99)):
            payload = {"box": "tech", "item": "iphone-pro", "price": 0, "actionId": f"tech-pack-open-{index:04d}"}
            with patch("app.secrets.randbelow", return_value=roll):
                response = self.request("POST", "/api/loot/open", payload, token)
            self.assertEqual(response.status_code, 200)
            data = response.get_json()["data"]
            self.assertEqual(data["item"]["key"], catalog["items"][index]["key"])
            self.assertEqual(sum(entry["quantity"] for entry in data["inventory"]), index+1)
            self.assertNotIn("payout", data)
            self.assertEqual(self.request("POST", "/api/loot/open", payload, token).status_code, 409)
        resumed = self.request("GET", "/api/loot/current", token=token).get_json()["data"]
        self.assertEqual(len(resumed["inventory"]), 6)
        self.assertEqual(resumed["history"][0]["item_key"], "iphone-pro")
        self.assertEqual(resumed["balance"], 500)

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

    def request(self, method, path, payload=None, token=None):
        headers = {"Origin": "http://127.0.0.1:8080"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.open(path, method=method, json=payload, headers=headers)

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

        admin = self.request("POST", "/api/admin/login", {"password": "2011"})
        self.assertEqual(admin.status_code, 200)
        admin_token = admin.get_json()["data"]["token"]
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
        admin_token = self.request("POST", "/api/admin/login", {"password": "2011"}).get_json()["data"]["token"]
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
