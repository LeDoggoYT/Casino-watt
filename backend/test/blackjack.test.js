import test from "node:test";
import assert from "node:assert/strict";
import { determineOutcome, handValue, isBlackjack } from "../src/blackjack.js";

const card = (rank, suit = "♠") => ({ rank, suit });

test("Asse werden automatisch von 11 auf 1 angepasst", () => {
  assert.equal(handValue([card("A"), card("A"), card("9")]), 21);
  assert.equal(handValue([card("A"), card("A"), card("9"), card("K")]), 21);
  assert.equal(handValue([card("A"), card("6"), card("K")]), 17);
});

test("nur zwei Karten mit 21 sind ein Blackjack", () => {
  assert.equal(isBlackjack([card("A"), card("K")]), true);
  assert.equal(isBlackjack([card("A"), card("5"), card("5")]), false);
});

test("Blackjack, Bust und Push werden korrekt erkannt", () => {
  assert.equal(determineOutcome([card("A"), card("K")], [card("10"), card("9")]), "blackjack");
  assert.equal(determineOutcome([card("K"), card("Q"), card("2")], [card("10"), card("7")]), "loss");
  assert.equal(determineOutcome([card("10"), card("8")], [card("K"), card("8")]), "push");
});
