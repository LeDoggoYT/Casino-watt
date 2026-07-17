import crypto from "node:crypto";
import { createSessionToken, hashToken } from "./auth.js";
import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { fail } from "./responses.js";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest();
}

export function verifyAdminPassword(value) {
  if (typeof value !== "string" || value.length > 128) return false;
  return crypto.timingSafeEqual(digest(value), digest(config.adminPassword));
}

export function createAdminSession() {
  const token = createSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO admin_sessions (token_hash, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), now.toISOString(), expiresAt.toISOString(), now.toISOString());
  return { token, expiresAt: expiresAt.toISOString() };
}

export function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token || token.length > 200) {
    return fail(res, 401, "Admin-Anmeldung erforderlich.");
  }

  const session = db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?").get(hashToken(token));
  if (!session || session.expires_at <= nowIso()) {
    if (session) db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(session.id);
    return fail(res, 401, "Die Admin-Sitzung ist abgelaufen.");
  }
  req.admin = session;
  db.prepare("UPDATE admin_sessions SET last_used_at = ? WHERE id = ?").run(nowIso(), session.id);
  return next();
}
