import express from "express";
import { createAdminSession, requireAdmin, verifyAdminPassword } from "../admin-auth.js";
import { db, nowIso } from "../db.js";
import { ApiError, ok } from "../responses.js";

export const adminRouter = express.Router();
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

function playerId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "Ungültige Spieler-ID.");
  return id;
}

function audit(userId, action, previousValue, newValue, reason = null) {
  db.prepare(`
    INSERT INTO admin_audit_log (
      target_user_id, action, previous_value, new_value, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    action,
    previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue === undefined ? null : JSON.stringify(newValue),
    reason,
    nowIso()
  );
}

adminRouter.post("/login", (req, res) => {
  if (!verifyAdminPassword(req.body?.password)) {
    throw new ApiError(401, "Das Admin-Passwort ist falsch.");
  }
  return ok(res, createAdminSession(), "Admin-Sitzung gestartet.");
});

adminRouter.post("/logout", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(req.admin.id);
  return ok(res, {}, "Admin-Sitzung beendet.");
});

adminRouter.get("/players", requireAdmin, (req, res) => {
  const requestedPage = Number.parseInt(req.query.page, 10);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = 50;
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 20) : "";
  const pattern = `%${search.toLocaleLowerCase("de-DE")}%`;
  const total = db.prepare("SELECT COUNT(*) AS count FROM users WHERE username_normalized LIKE ?").get(pattern).count;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);

  const players = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.last_activity_at,
           u.is_suspended, u.suspension_reason, u.suspended_at,
           b.amount AS balance, s.rounds_played, s.wins, s.losses,
           EXISTS(SELECT 1 FROM active_rounds r WHERE r.user_id = u.id) AS has_active_round
    FROM users u
    JOIN balances b ON b.user_id = u.id
    JOIN player_stats s ON s.user_id = u.id
    WHERE u.username_normalized LIKE ?
    ORDER BY u.username_normalized ASC
    LIMIT ? OFFSET ?
  `).all(pattern, limit, (safePage - 1) * limit).map((player) => ({
    id: player.id,
    username: player.username,
    balance: player.balance,
    roundsPlayed: player.rounds_played,
    wins: player.wins,
    losses: player.losses,
    suspended: Boolean(player.is_suspended),
    suspensionReason: player.suspension_reason,
    suspendedAt: player.suspended_at,
    hasActiveRound: Boolean(player.has_active_round),
    createdAt: player.created_at,
    lastActivityAt: player.last_activity_at
  }));

  return ok(res, { players, pagination: { page: safePage, limit, total, totalPages } });
});

const setBalance = db.transaction((id, amount, reason) => {
  const player = db.prepare(`
    SELECT u.username, b.amount AS balance,
           EXISTS(SELECT 1 FROM active_rounds r WHERE r.user_id = u.id) AS has_active_round
    FROM users u JOIN balances b ON b.user_id = u.id WHERE u.id = ?
  `).get(id);
  if (!player) throw new ApiError(404, "Spieler nicht gefunden.");
  if (player.has_active_round) throw new ApiError(409, "Das Guthaben kann während einer laufenden Runde nicht geändert werden.");

  const now = nowIso();
  db.prepare("UPDATE balances SET amount = ?, updated_at = ? WHERE user_id = ?").run(amount, now, id);
  db.prepare("UPDATE player_stats SET highest_balance = MAX(highest_balance, ?) WHERE user_id = ?").run(amount, id);
  audit(id, "balance", player.balance, amount, reason);
});

adminRouter.patch("/players/:id/balance", requireAdmin, (req, res) => {
  const id = playerId(req.params.id);
  const amount = Number(req.body?.amount);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000 || Math.round(amount * 2) !== amount * 2) {
    throw new ApiError(400, "Das Guthaben muss zwischen 0 und 1.000.000.000 liegen und auf halbe Chips gerundet sein.");
  }
  setBalance(id, amount, reason || null);
  return ok(res, { balance: amount }, "Guthaben aktualisiert.");
});

const renamePlayer = db.transaction((id, username) => {
  const player = db.prepare("SELECT username FROM users WHERE id = ?").get(id);
  if (!player) throw new ApiError(404, "Spieler nicht gefunden.");
  try {
    db.prepare("UPDATE users SET username = ?, username_normalized = ? WHERE id = ?")
      .run(username, username.toLocaleLowerCase("de-DE"), id);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new ApiError(409, "Dieser Benutzername ist bereits vergeben.");
    throw error;
  }
  audit(id, "username", player.username, username);
});

adminRouter.patch("/players/:id/username", requireAdmin, (req, res) => {
  const id = playerId(req.params.id);
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, "Der Benutzername muss 3–20 Zeichen lang sein und darf Buchstaben, Zahlen, _ und - enthalten.");
  }
  renamePlayer(id, username);
  return ok(res, { username }, "Benutzername aktualisiert.");
});

const setSuspension = db.transaction((id, suspended, reason) => {
  const player = db.prepare("SELECT username, is_suspended, suspension_reason FROM users WHERE id = ?").get(id);
  if (!player) throw new ApiError(404, "Spieler nicht gefunden.");
  const now = nowIso();
  db.prepare(`
    UPDATE users SET is_suspended = ?, suspension_reason = ?, suspended_at = ? WHERE id = ?
  `).run(suspended ? 1 : 0, suspended ? reason : null, suspended ? now : null, id);
  audit(
    id,
    suspended ? "suspend" : "unsuspend",
    { suspended: Boolean(player.is_suspended), reason: player.suspension_reason },
    { suspended, reason: suspended ? reason : null },
    suspended ? reason : null
  );
});

adminRouter.patch("/players/:id/suspension", requireAdmin, (req, res) => {
  const id = playerId(req.params.id);
  const suspended = req.body?.suspended;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (typeof suspended !== "boolean") throw new ApiError(400, "Der Sperrstatus fehlt.");
  if (suspended && (reason.length < 3 || reason.length > 300)) {
    throw new ApiError(400, "Für eine Sperre ist eine Begründung mit 3–300 Zeichen erforderlich.");
  }
  setSuspension(id, suspended, reason);
  return ok(res, { suspended, reason: suspended ? reason : null }, suspended ? "Spieler gesperrt." : "Sperre aufgehoben.");
});
