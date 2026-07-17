import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { ApiError } from "./responses.js";
import {
  createShoe,
  determineOutcome,
  draw,
  handValue,
  isBlackjack,
  outcomeMessage,
  playDealer
} from "./blackjack.js";

function parseRound(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    bet: row.bet,
    deck: JSON.parse(row.deck_json),
    playerCards: JSON.parse(row.player_cards_json),
    dealerCards: JSON.parse(row.dealer_cards_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadRound(userId) {
  return parseRound(db.prepare("SELECT * FROM active_rounds WHERE user_id = ?").get(userId));
}

function saveRound(round) {
  const now = nowIso();
  db.prepare(`
    UPDATE active_rounds
    SET bet = ?, deck_json = ?, player_cards_json = ?, dealer_cards_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    round.bet,
    JSON.stringify(round.deck),
    JSON.stringify(round.playerCards),
    JSON.stringify(round.dealerCards),
    now,
    round.id,
    round.userId
  );
  round.updatedAt = now;
}

function registerAction(userId, actionId, actionType) {
  if (typeof actionId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(actionId)) {
    throw new ApiError(400, "Für diese Aktion fehlt eine gültige Aktions-ID.");
  }
  try {
    db.prepare(`
      INSERT INTO action_requests (user_id, action_id, action_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, actionId, actionType, nowIso());
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ApiError(409, "Diese Aktion wurde bereits verarbeitet.");
    }
    throw error;
  }
}

function publicRound(round, balance, revealDealer = false, result = null) {
  const dealerCards = revealDealer
    ? round.dealerCards
    : round.dealerCards.map((card, index) => (index === 1 ? { hidden: true } : card));
  const playerValue = handValue(round.playerCards);
  const dealerValue = revealDealer ? handValue(round.dealerCards) : handValue([round.dealerCards[0]]);

  return {
    id: round.id,
    bet: round.bet,
    playerCards: round.playerCards,
    dealerCards,
    playerValue,
    dealerValue,
    dealerRevealed: revealDealer,
    status: result ? "completed" : "active",
    allowedActions: result
      ? []
      : ["hit", "stand", ...(round.playerCards.length === 2 && balance >= round.bet ? ["double"] : [])],
    result,
    startedAt: round.createdAt
  };
}

function payoutMultiplier(outcome) {
  if (outcome === "blackjack") return 2.5;
  if (outcome === "win") return 2;
  if (outcome === "push") return 1;
  return 0;
}

function settleRound(round, outcome) {
  const balanceRow = db.prepare("SELECT amount FROM balances WHERE user_id = ?").get(round.userId);
  if (!balanceRow) throw new ApiError(404, "Spielerkonto nicht gefunden.");

  const payout = round.bet * payoutMultiplier(outcome);
  const balanceBefore = balanceRow.amount + round.bet;
  const balanceAfter = balanceRow.amount + payout;
  const netResult = balanceAfter - balanceBefore;
  const completedAt = nowIso();
  const durationSeconds = Math.max(
    0,
    Math.min(86400, Math.floor((Date.parse(completedAt) - Date.parse(round.createdAt)) / 1000))
  );

  db.prepare("UPDATE balances SET amount = ?, updated_at = ? WHERE user_id = ?")
    .run(balanceAfter, completedAt, round.userId);

  const stats = db.prepare("SELECT * FROM player_stats WHERE user_id = ?").get(round.userId);
  let currentStreak = stats.current_streak;
  if (outcome === "win" || outcome === "blackjack") {
    currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
  } else if (outcome === "loss") {
    currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
  }

  const isWin = outcome === "win" || outcome === "blackjack";
  db.prepare(`
    UPDATE player_stats
    SET rounds_played = rounds_played + 1,
        wins = wins + ?,
        losses = losses + ?,
        pushes = pushes + ?,
        blackjacks = blackjacks + ?,
        highest_balance = MAX(highest_balance, ?),
        biggest_win = MAX(biggest_win, ?),
        total_won = total_won + ?,
        total_lost = total_lost + ?,
        current_streak = ?,
        best_win_streak = MAX(best_win_streak, ?)
    WHERE user_id = ?
  `).run(
    isWin ? 1 : 0,
    outcome === "loss" ? 1 : 0,
    outcome === "push" ? 1 : 0,
    outcome === "blackjack" ? 1 : 0,
    balanceAfter,
    Math.max(0, netResult),
    Math.max(0, netResult),
    Math.max(0, -netResult),
    currentStreak,
    Math.max(0, currentStreak),
    round.userId
  );

  db.prepare(`
    INSERT INTO completed_rounds (
      id, user_id, bet, outcome, player_cards_json, dealer_cards_json,
      balance_before, balance_after, net_result, started_at, completed_at, duration_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    round.id,
    round.userId,
    round.bet,
    outcome,
    JSON.stringify(round.playerCards),
    JSON.stringify(round.dealerCards),
    balanceBefore,
    balanceAfter,
    netResult,
    round.createdAt,
    completedAt,
    durationSeconds
  );
  db.prepare("DELETE FROM active_rounds WHERE id = ? AND user_id = ?").run(round.id, round.userId);

  const result = {
    outcome,
    payout,
    netResult,
    message: outcomeMessage(outcome, round.playerCards, round.dealerCards)
  };
  return { round: publicRound(round, balanceAfter, true, result), balance: balanceAfter };
}

function dealerAndSettle(round) {
  playDealer(round.deck, round.dealerCards);
  saveRound(round);
  return settleRound(round, determineOutcome(round.playerCards, round.dealerCards));
}

export const startRound = db.transaction((userId, bet, actionId) => {
  registerAction(userId, actionId, "start");
  if (loadRound(userId)) throw new ApiError(409, "Es läuft bereits eine Runde.");
  if (!Number.isFinite(bet) || bet < 5 || Math.round(bet * 2) !== bet * 2) {
    throw new ApiError(400, "Der Einsatz muss mindestens 5 Chips betragen.");
  }

  const balanceRow = db.prepare("SELECT amount FROM balances WHERE user_id = ?").get(userId);
  if (!balanceRow || bet > balanceRow.amount) throw new ApiError(400, "Für diesen Einsatz reichen die Chips nicht aus.");

  const now = nowIso();
  const deck = createShoe();
  const playerCards = [draw(deck)];
  const dealerCards = [draw(deck)];
  playerCards.push(draw(deck));
  dealerCards.push(draw(deck));
  const round = {
    id: crypto.randomUUID(),
    userId,
    bet,
    deck,
    playerCards,
    dealerCards,
    createdAt: now,
    updatedAt: now
  };

  db.prepare("UPDATE balances SET amount = amount - ?, updated_at = ? WHERE user_id = ? AND amount >= ?")
    .run(bet, now, userId, bet);
  db.prepare(`
    INSERT INTO active_rounds (
      id, user_id, bet, deck_json, player_cards_json, dealer_cards_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    round.id,
    userId,
    bet,
    JSON.stringify(deck),
    JSON.stringify(playerCards),
    JSON.stringify(dealerCards),
    now,
    now
  );

  const balance = balanceRow.amount - bet;
  if (isBlackjack(playerCards) || isBlackjack(dealerCards)) {
    return settleRound(round, determineOutcome(playerCards, dealerCards));
  }
  return { round: publicRound(round, balance), balance };
});

export const hitRound = db.transaction((userId, actionId) => {
  registerAction(userId, actionId, "hit");
  const round = loadRound(userId);
  if (!round) throw new ApiError(409, "Es läuft keine Runde.");

  round.playerCards.push(draw(round.deck));
  if (handValue(round.playerCards) > 21) {
    saveRound(round);
    return settleRound(round, "loss");
  }
  if (handValue(round.playerCards) === 21) return dealerAndSettle(round);

  saveRound(round);
  const balance = db.prepare("SELECT amount FROM balances WHERE user_id = ?").get(userId).amount;
  return { round: publicRound(round, balance), balance };
});

export const standRound = db.transaction((userId, actionId) => {
  registerAction(userId, actionId, "stand");
  const round = loadRound(userId);
  if (!round) throw new ApiError(409, "Es läuft keine Runde.");
  return dealerAndSettle(round);
});

export const doubleRound = db.transaction((userId, actionId) => {
  registerAction(userId, actionId, "double");
  const round = loadRound(userId);
  if (!round) throw new ApiError(409, "Es läuft keine Runde.");
  if (round.playerCards.length !== 2) throw new ApiError(409, "Verdoppeln ist nur mit zwei Karten möglich.");

  const balanceRow = db.prepare("SELECT amount FROM balances WHERE user_id = ?").get(userId);
  if (balanceRow.amount < round.bet) throw new ApiError(400, "Für das Verdoppeln reichen die Chips nicht aus.");

  db.prepare("UPDATE balances SET amount = amount - ?, updated_at = ? WHERE user_id = ? AND amount >= ?")
    .run(round.bet, nowIso(), userId, round.bet);
  round.bet *= 2;
  round.playerCards.push(draw(round.deck));
  saveRound(round);

  if (handValue(round.playerCards) > 21) return settleRound(round, "loss");
  return dealerAndSettle(round);
});

export function getCurrentRound(userId) {
  const round = loadRound(userId);
  const balance = db.prepare("SELECT amount FROM balances WHERE user_id = ?").get(userId)?.amount ?? 0;
  return { round: round ? publicRound(round, balance) : null, balance };
}
