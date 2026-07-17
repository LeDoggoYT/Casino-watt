import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { fail } from "./responses.js";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function requireAuth(req, res, next) {
  const authorization = req.get("authorization") ?? "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token || token.length > 200) {
    return fail(res, 401, "Bitte erneut anmelden.");
  }

  const session = db.prepare(`
    SELECT s.id AS session_id, s.user_id, s.expires_at,
           u.username, b.amount AS balance
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN balances b ON b.user_id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));

  if (!session || session.expires_at <= nowIso()) {
    if (session) db.prepare("DELETE FROM sessions WHERE id = ?").run(session.session_id);
    return fail(res, 401, "Die Sitzung ist abgelaufen. Bitte erneut anmelden.");
  }

  req.auth = session;
  const now = nowIso();
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(now, session.session_id);
  db.prepare("UPDATE users SET last_activity_at = ? WHERE id = ?").run(now, session.user_id);
  return next();
}
