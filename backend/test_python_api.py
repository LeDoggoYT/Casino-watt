import os
import tempfile
import unittest
from pathlib import Path

TEMP_DB = Path(tempfile.gettempdir()) / "watt-casino-python-api-test.sqlite"
for suffix in ("", "-shm", "-wal"):
    TEMP_DB.with_name(TEMP_DB.name + suffix).unlink(missing_ok=True)
os.environ["DATABASE_PATH"] = str(TEMP_DB)
os.environ["NODE_ENV"] = "development"
os.environ["ADMIN_PASSWORD"] = "2011"

from app import app, outcome as determine_outcome, hand_value, blackjack as is_blackjack  # noqa: E402


class WattCasinoApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def request(self, method, path, payload=None, token=None):
        headers = {"Origin": "http://127.0.0.1:8080"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.open(path, method=method, json=payload, headers=headers)

    def test_auth_game_admin_and_suspension(self):
        player = {"username": "PythonPlayer", "password": "SicheresTestpasswort9"}
        registered = self.request("POST", "/api/auth/register", player)
        self.assertEqual(registered.status_code, 201)
        token = registered.get_json()["data"]["token"]

        me = self.request("GET", "/api/auth/me", token=token)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.get_json()["data"]["user"]["balance"], 1000)

        game = self.request("POST", "/api/game/start", {"bet": 25, "actionId": "python-start-action-0001"}, token)
        self.assertEqual(game.status_code, 201)
        self.assertTrue(game.get_json()["success"])

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


if __name__ == "__main__":
    unittest.main()
