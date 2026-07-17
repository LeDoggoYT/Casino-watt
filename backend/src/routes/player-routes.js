import express from "express";
import { requireAuth } from "../auth.js";
import { db } from "../db.js";
import { ApiError, ok } from "../responses.js";

export const playerRouter = express.Router();
playerRouter.use(requireAuth);

function rates(row) {
  const completed = row.rounds_played || 0;
  return {
    winRate: completed ? Number(((row.wins / completed) * 100).toFixed(1)) : 0,
    lossRate: completed ? Number(((row.losses / completed) * 100).toFixed(1)) : 0
  };
}

playerRouter.get("/leaderboard", (req, res) => {
  const requestedPage = Number.parseInt(req.query.page, 10);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 25;
  const total = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;

  const rows = db.prepare(`
    SELECT u.username, b.amount AS balance, s.rounds_played, s.wins, s.losses,
           RANK() OVER (ORDER BY b.amount DESC) AS rank
    FROM users u
    JOIN balances b ON b.user_id = u.id
    JOIN player_stats s ON s.user_id = u.id
    ORDER BY b.amount DESC, u.username_normalized ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const players = rows.map((row) => ({
    rank: row.rank,
    username: row.username,
    balance: row.balance,
    roundsPlayed: row.rounds_played,
    winRate: rates(row).winRate,
    isCurrentUser: row.username.toLocaleLowerCase("de-DE") === req.auth.username.toLocaleLowerCase("de-DE")
  }));

  return ok(res, { players, pagination: { page: safePage, limit, total, totalPages } });
});

playerRouter.get("/players/:username", (req, res) => {
  const username = req.params.username;
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) throw new ApiError(400, "Ungültiger Benutzername.");

  const row = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.last_activity_at,
           b.amount AS balance,
           s.rounds_played, s.wins, s.losses, s.pushes, s.blackjacks,
           s.highest_balance, s.biggest_win, s.total_won, s.total_lost,
           s.current_streak, s.best_win_streak, s.total_play_seconds,
           (SELECT 1 + COUNT(*) FROM balances other WHERE other.amount > b.amount) AS rank
    FROM users u
    JOIN balances b ON b.user_id = u.id
    JOIN player_stats s ON s.user_id = u.id
    WHERE u.username_normalized = ?
  `).get(username.toLocaleLowerCase("de-DE"));
  if (!row) throw new ApiError(404, "Spieler nicht gefunden.");

  const { winRate, lossRate } = rates(row);
  const streak = row.current_streak > 0
    ? { type: "win", count: row.current_streak }
    : row.current_streak < 0
      ? { type: "loss", count: Math.abs(row.current_streak) }
      : { type: "none", count: 0 };

  return ok(res, {
    player: {
      username: row.username,
      balance: row.balance,
      rank: row.rank,
      roundsPlayed: row.rounds_played,
      wins: row.wins,
      losses: row.losses,
      pushes: row.pushes,
      blackjacks: row.blackjacks,
      winRate,
      lossRate,
      highestBalance: row.highest_balance,
      biggestWin: row.biggest_win,
      totalWon: row.total_won,
      totalLost: row.total_lost,
      currentStreak: streak,
      bestWinStreak: row.best_win_streak,
      totalPlaySeconds: row.total_play_seconds,
      registeredAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      isCurrentUser: row.id === req.auth.user_id
    }
  });
});
