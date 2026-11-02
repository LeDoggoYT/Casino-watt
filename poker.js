"use strict";

const pokerUi = {
  entry: document.querySelector("#poker-entry"), table: document.querySelector("#poker-table"),
  message: document.querySelector("#poker-message"), create: document.querySelector("#poker-create-form"),
  nameInput: document.querySelector("#poker-name"), refresh: document.querySelector("#poker-refresh"),
  list: document.querySelector("#poker-lobby-list"),
  name: document.querySelector("#poker-lobby-name"), players: document.querySelector("#poker-players"),
  leave: document.querySelector("#poker-leave"), start: document.querySelector("#poker-start"),
  draw: document.querySelector("#poker-draw"), call: document.querySelector("#poker-call"),
  fold: document.querySelector("#poker-fold"), raiseForm: document.querySelector("#poker-raise-form"),
  raiseAmount: document.querySelector("#poker-raise-amount"), raiseTotal: document.querySelector("#poker-raise-total"),
  balance: document.querySelector("#poker-balance"),
  turn: document.querySelector("#poker-turn"), wager: document.querySelector("#poker-wager"),
  hand: document.querySelector("#poker-hand"), street: document.querySelector("#poker-street"),
  board: document.querySelector("#poker-board-cards"), mine: document.querySelector("#poker-my-cards"),
  opponent: document.querySelector("#poker-opponent"), pot: document.querySelector("#poker-pot")
};
let pokerTimer = null;
let pokerBusy = false;
let pokerLobby = null;

function updatePokerRaiseTotal() {
  const toCall = pokerLobby?.hand?.toCall ?? 0;
  const increase = Number(pokerUi.raiseAmount.value);
  pokerUi.raiseTotal.textContent = pokerLobby?.status === "playing" && Number.isFinite(increase) && increase >= 5
    ? `Du setzt ${formatChips(toCall + increase)} Chips` : "";
}

function pokerCards(container, cards, slots = cards.length, faceDown = false) {
  container.replaceChildren();
  for (const card of cards) {
    const element = document.createElement("span");
    element.className = `poker-card${faceDown ? " poker-card--back" : /[hd]$/.test(card) ? " is-red" : ""}`;
    if (!faceDown) {
      const rank = document.createElement("span");
      rank.textContent = card[0] === "T" ? "10" : card[0];
      const suit = document.createElement("span");
      suit.textContent = {s:"♠",h:"♥",d:"♦",c:"♣"}[card[1]];
      element.append(rank, suit);
      element.setAttribute("aria-label", `${rank.textContent} ${suit.textContent}`);
    } else element.setAttribute("aria-label", "Verdeckte Karte");
    container.append(element);
  }
  for (let index = cards.length; index < slots; index++) {
    const placeholder = document.createElement("span");
    placeholder.className = "poker-card poker-card--empty";
    placeholder.setAttribute("aria-label", "Noch nicht aufgedeckt");
    container.append(placeholder);
  }
}

function renderPoker(lobby) {
  pokerLobby = lobby;
  pokerUi.entry.hidden = Boolean(lobby);
  pokerUi.table.hidden = !lobby;
  pokerUi.balance.textContent = formatChips(lobby?.balance ?? state.balance);
  if (!lobby) return;
  pokerUi.name.textContent = lobby.name;
  pokerUi.players.textContent = `Spieler: ${lobby.players.map(player => player.username).join(" · ")}${lobby.players.length < 2 ? " · Warte auf Mitspieler …" : ""}`;
  pokerUi.hand.hidden = !lobby.hand;
  pokerUi.start.hidden = lobby.hostId !== lobby.meId || lobby.status === "playing";
  pokerUi.start.disabled = pokerBusy || lobby.players.length !== 2;
  pokerUi.start.textContent = lobby.status === "finished" ? "Nächste Runde · 10 Chips" : "Runde starten · 10 Chips";
  const playing = lobby.status === "playing";
  const myTurn = playing && lobby.hand?.turnId === lobby.meId;
  const toCall = lobby.hand?.toCall ?? 0;
  const maxRaise = lobby.hand?.maxRaise ?? 0;
  pokerUi.draw.hidden = !playing || toCall > 0;
  pokerUi.call.hidden = !playing || toCall === 0;
  pokerUi.raiseForm.hidden = !playing;
  pokerUi.fold.hidden = lobby.status !== "playing";
  pokerUi.draw.disabled = pokerBusy || !myTurn;
  pokerUi.call.disabled = pokerBusy || !myTurn || lobby.balance < toCall;
  pokerUi.fold.disabled = pokerBusy || !myTurn;
  pokerUi.raiseAmount.disabled = pokerBusy || !myTurn || maxRaise < 5;
  pokerUi.raiseAmount.max = String(maxRaise);
  if (maxRaise >= 5 && (Number(pokerUi.raiseAmount.value) > maxRaise || Number(pokerUi.raiseAmount.value) < 5)) pokerUi.raiseAmount.value = String(Math.min(10, maxRaise));
  updatePokerRaiseTotal();
  pokerUi.raiseForm.querySelector("button").disabled = pokerBusy || !myTurn || maxRaise < 5;
  pokerUi.draw.textContent = lobby.hand?.street === "river" ? "Zum Showdown" : "Karte ziehen";
  pokerUi.call.textContent = `Mitgehen · ${formatChips(toCall)} Chips`;
  if (!lobby.hand) {
    pokerUi.message.textContent = lobby.players.length < 2 ? "Deine Lobby ist offen. Andere Spieler können sie nach Namen auswählen." : "Beide Spieler sind bereit. Der Host kann starten.";
    return;
  }
  pokerUi.street.textContent = {preflop:"Startkarten",flop:"Flop",turn:"Turn",river:"River"}[lobby.hand.street];
  pokerUi.pot.textContent = formatChips(lobby.hand.pot);
  pokerCards(pokerUi.board, lobby.hand.board, 5);
  pokerCards(pokerUi.mine, lobby.hand.cards);
  const opponent = lobby.players.find(player => player.id !== lobby.meId);
  document.querySelector(".poker-seat--opponent .poker-seat-label").textContent = opponent?.username || "Mitspieler";
  const opponentCards = lobby.hand.opponentCards[String(opponent?.id)] || [];
  pokerCards(pokerUi.opponent, opponentCards.length ? opponentCards : ["", ""], 2, !opponentCards.length);
  pokerUi.turn.textContent = playing ? myTurn ? "Du bist am Zug" : `${opponent?.username || "Mitspieler"} ist am Zug` : "Runde beendet";
  pokerUi.wager.textContent = playing && toCall ? `Noch ${formatChips(toCall)} Chips zum Mitgehen` : playing ? "Kein offener Einsatz" : "";
  if (lobby.status === "finished") {
    const winner = lobby.players.find(player => player.id === lobby.hand.result?.winnerId);
    pokerUi.message.textContent = `${lobby.hand.result?.message || "Runde beendet."} ${winner ? `${winner.username} gewinnt ${formatChips(lobby.hand.pot)} Chips.` : ""}`;
  } else {
    pokerUi.message.textContent = myTurn ? toCall ? "Gehe mit, erhöhe oder passe." : "Ziehe die nächste Gemeinschaftskarte, erhöhe oder passe." : "Warte auf den Zug der anderen Person.";
  }
  state.balance = lobby.balance;
  if (typeof updateControls === "function") updateControls();
}

function renderPokerLobbies(lobbies) {
  pokerUi.list.replaceChildren();
  if (!lobbies.length) {
    pokerUi.list.textContent = "Gerade ist keine Lobby offen. Erstelle deine eigene!";
    return;
  }
  for (const lobby of lobbies) {
    const row = document.createElement("div");
    row.className = "poker-lobby-row";
    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = lobby.name;
    const detail = document.createElement("small");
    detail.textContent = `Host: ${lobby.host} · ${lobby.players}/2 Spieler`;
    label.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Beitreten";
    button.addEventListener("click", () => pokerRequest("join", {name: lobby.name}));
    row.append(label, button);
    pokerUi.list.append(row);
  }
}

async function loadPoker() {
  if (!state.token || state.activeView !== "poker" || pokerBusy || document.hidden) return;
  try {
    const data = await api("/api/poker/current");
    if (state.activeView !== "poker" || pokerBusy) return;
    renderPoker(data.lobby);
    if (!data.lobby) {
      const available = await api("/api/poker/lobbies");
      if (state.activeView === "poker" && !pokerBusy && !pokerLobby) renderPokerLobbies(available.lobbies);
    }
  } catch (error) {
    pokerUi.message.textContent = error.message;
  }
}

function startPoker() {
  if (pokerTimer) clearInterval(pokerTimer);
  loadPoker();
  pokerTimer = setInterval(loadPoker, 3000);
}

function stopPoker() {
  if (pokerTimer) clearInterval(pokerTimer);
  pokerTimer = null;
  pokerLobby = null;
}

async function pokerRequest(path, payload = {}) {
  if (pokerBusy) return;
  pokerBusy = true;
  pokerUi.message.textContent = "Verbindung zum Poker-Tisch …";
  let requestError = null;
  try {
    const data = await api(`/api/poker/${path}`, {method:"POST", body:JSON.stringify(path === "action" ? {...payload, actionId: actionId()} : payload)});
    renderPoker(data.lobby || null);
    if (path === "leave") pokerUi.message.textContent = "Du hast die Lobby verlassen.";
  } catch (error) {
    requestError = error.message;
    pokerUi.message.textContent = error.message;
  } finally {
    pokerBusy = false;
    if (pokerLobby) renderPoker(pokerLobby);
    else if (path === "leave") loadPoker();
    if (requestError) pokerUi.message.textContent = requestError;
  }
}

pokerUi.create.addEventListener("submit", event => {
  event.preventDefault();
  pokerRequest("create", {name:pokerUi.nameInput.value.trim()});
});
pokerUi.refresh.addEventListener("click", loadPoker);
pokerUi.leave.addEventListener("click", () => pokerRequest("leave"));
pokerUi.start.addEventListener("click", () => pokerRequest("start"));
pokerUi.draw.addEventListener("click", () => pokerRequest("action", {action:"draw"}));
pokerUi.call.addEventListener("click", () => pokerRequest("action", {action:"call"}));
pokerUi.raiseForm.addEventListener("submit", event => {
  event.preventDefault();
  if (pokerUi.raiseForm.reportValidity()) pokerRequest("action", {action:"raise", amount:Number(pokerUi.raiseAmount.value)});
});
pokerUi.raiseAmount.addEventListener("input", updatePokerRaiseTotal);
pokerUi.fold.addEventListener("click", () => pokerRequest("action", {action:"fold"}));
