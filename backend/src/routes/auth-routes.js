import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcrypt";
import { config } from "../config.js";
import { createSessionToken, hashToken, requireAuth } from "../auth.js";
import { db, nowIso } from "../db.js";
import { ApiError, ok } from "../responses.js";

export const authRouter = express.Router();
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

function validateCredentials(username, password) {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, "Der Benutzername muss 3–20 Zeichen lang sein und darf Buchstaben, Zahlen, _ und - enthalten.");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new ApiError(400, "Das Passwort muss 8–128 Zeichen lang sein.");
  }
  return { username, normalized: username.toLocaleLowerCase("de-DE") };
}

function issueSession(userId) {
  const token = createSessionToken();
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionDays * 86400000);
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, hashToken(token), now.toISOString(), expires.toISOString(), now.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

const registerAccount = db.transaction((username, normalized, passwordHash) => {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO users (username, username_normalized, password_hash, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, normalized, passwordHash, now, now);
  const userId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO balances (user_id, amount, updated_at) VALUES (?, 1000, ?)").run(userId, now);
  db.prepare("INSERT INTO player_stats (user_id) VALUES (?)").run(userId);
  return userId;
});

authRouter.post("/register", async (req, res) => {
  const { username, normalized } = validateCredentials(req.body?.username, req.body?.password);
  const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);
  let userId;

  try {
    userId = registerAccount(username, normalized, passwordHash);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ApiError(409, "Dieser Benutzername ist bereits vergeben.");
    }
    throw error;
  }

  const session = issueSession(userId);
  return ok(res, {
    token: session.token,
    expiresAt: session.expiresAt,
    user: { username, balance: 1000 }
  }, "Konto erstellt.", 201);
});

authRouter.post("/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password || username.length > 20 || password.length > 128) {
    throw new ApiError(401, "Benutzername oder Passwort ist falsch.");
  }

  const user = db.prepare(`
    SELECT u.id, u.username, u.password_hash, b.amount AS balance
    FROM users u JOIN balances b ON b.user_id = u.id
    WHERE u.username_normalized = ?
  `).get(username.toLocaleLowerCase("de-DE"));

  const fallbackHash = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5ZxQwDPZ9vtQd0Z4E4YW/.GQqX9vJ6G";
  const valid = await bcrypt.compare(password, user?.password_hash ?? fallbackHash);
  if (!user || !valid) throw new ApiError(401, "Benutzername oder Passwort ist falsch.");

  const session = issueSession(user.id);
  return ok(res, {
    token: session.token,
    expiresAt: session.expiresAt,
    user: { username: user.username, balance: user.balance }
  }, "Angemeldet.");
});

authRouter.post("/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.auth.session_id);
  return ok(res, {}, "Abgemeldet.");
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.username, u.created_at, u.last_activity_at, b.amount AS balance,
           s.rounds_played, s.wins, s.losses, s.pushes, s.blackjacks
    FROM users u
    JOIN balances b ON b.user_id = u.id
    JOIN player_stats s ON s.user_id = u.id
    WHERE u.id = ?
  `).get(req.auth.user_id);
  return ok(res, { user });
});
