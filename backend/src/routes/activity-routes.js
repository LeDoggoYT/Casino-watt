import express from "express";
import { requireAuth } from "../auth.js";
import { db, nowIso } from "../db.js";
import { ApiError, ok } from "../responses.js";

export const activityRouter = express.Router();

const recordActivity = db.transaction((auth, active) => {
  const now = nowIso();
  const existing = db.prepare("SELECT * FROM activity_sessions WHERE session_id = ?").get(auth.session_id);

  if (!existing) {
    db.prepare(`
      INSERT INTO activity_sessions (
        session_id, user_id, started_at, last_ping_at, is_active, accrued_seconds
      ) VALUES (?, ?, ?, ?, ?, 0)
    `).run(auth.session_id, auth.user_id, now, now, active ? 1 : 0);
    return 0;
  }

  let credited = 0;
  const elapsed = Math.floor((Date.parse(now) - Date.parse(existing.last_ping_at)) / 1000);
  if (active && existing.is_active === 1 && elapsed > 0 && elapsed <= 60) {
    credited = Math.min(elapsed, 45);
  }

  db.prepare(`
    UPDATE activity_sessions
    SET last_ping_at = ?, is_active = ?, accrued_seconds = accrued_seconds + ?
    WHERE session_id = ?
  `).run(now, active ? 1 : 0, credited, auth.session_id);
  if (credited > 0) {
    db.prepare("UPDATE player_stats SET total_play_seconds = total_play_seconds + ? WHERE user_id = ?")
      .run(credited, auth.user_id);
  }
  return credited;
});

activityRouter.post("/activity", requireAuth, (req, res) => {
  if (typeof req.body?.active !== "boolean") throw new ApiError(400, "Das Aktivitätsfeld muss true oder false sein.");
  const creditedSeconds = recordActivity(req.auth, req.body.active);
  return ok(res, { creditedSeconds });
});
