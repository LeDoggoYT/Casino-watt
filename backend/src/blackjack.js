import crypto from "node:crypto";

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

export function createShoe(deckCount = 6) {
  const shoe = [];
  for (let deck = 0; deck < deckCount; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) shoe.push({ rank, suit });
    }
  }

  for (let index = shoe.length - 1; index > 0; index -= 1) {
    const randomIndex = crypto.randomInt(index + 1);
    [shoe[index], shoe[randomIndex]] = [shoe[randomIndex], shoe[index]];
  }
  return shoe;
}

export function draw(deck) {
  const card = deck.pop();
  if (!card) throw new Error("Der Kartenschlitten ist leer.");
  return card;
}

export function handValue(cards) {
  let value = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      value += 11;
      aces += 1;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      value += 10;
    } else {
      value += Number(card.rank);
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }
  return value;
}

export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

export function playDealer(deck, dealerCards) {
  while (handValue(dealerCards) < 17) dealerCards.push(draw(deck));
}

export function determineOutcome(playerCards, dealerCards) {
  const playerValue = handValue(playerCards);
  const dealerValue = handValue(dealerCards);

  if (playerValue > 21) return "loss";
  if (isBlackjack(playerCards) && !isBlackjack(dealerCards)) return "blackjack";
  if (isBlackjack(dealerCards) && !isBlackjack(playerCards)) return "loss";
  if (dealerValue > 21 || playerValue > dealerValue) return "win";
  if (playerValue < dealerValue) return "loss";
  return "push";
}

export function outcomeMessage(outcome, playerCards, dealerCards) {
  const player = handValue(playerCards);
  const dealer = handValue(dealerCards);
  if (outcome === "blackjack") return "Blackjack! Auszahlung 3 zu 2.";
  if (outcome === "push") return `Gleichstand bei ${player} – Einsatz zurück.`;
  if (outcome === "loss" && player > 21) return `Mit ${player} überkauft – der Dealer gewinnt.`;
  if (outcome === "loss") return `${dealer} schlägt ${player} – der Dealer gewinnt.`;
  if (dealer > 21) return `Dealer überkauft mit ${dealer} – Sie gewinnen.`;
  return `${player} schlägt ${dealer} – Sie gewinnen.`;
}
