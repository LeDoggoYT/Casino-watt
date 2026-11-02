"use strict";

const pokerUi = {
  entry: document.querySelector("#poker-entry"), table: document.querySelector("#poker-table"),
  message: document.querySelector("#poker-message"), create: document.querySelector("#poker-create"),
  join: document.querySelector("#poker-join-form"), codeInput: document.querySelector("#poker-code"),
  code: document.querySelector("#poker-lobby-code"), players: document.querySelector("#poker-players"),
  leave: document.querySelector("#poker-leave"), start: document.querySelector("#poker-start"),
  check: document.querySelector("#poker-check"), fold: document.querySelector("#poker-fold"),
  hand: document.querySelector("#poker-hand"), street: document.querySelector("#poker-street"),
  board: document.querySelector("#poker-board-cards"), mine: document.querySelector("#poker-my-cards"),
  opponent: document.querySelector("#poker-opponent"), pot: document.querySelector("#poker-pot")
};
let pokerTimer = null;
let pokerBusy = false;
let pokerLobby = null;

function pokerCards(container, cards) {
  container.replaceChildren();
  for (const card of cards) {
    const element = document.createElement("span");
    element.className = `poker-card${/[hd]$/.test(card) ? " is-red" : ""}`;
    element.textContent = `${card[0] === "T" ? "10" : card[0]}${{s:"♠",h:"♥",d:"♦",c:"♣"}[card[1]]}`;
    container.append(element);
  }
  if (!cards.length) container.textContent = "Noch keine Karten";
}

function renderPoker(lobby) {
  pokerLobby = lobby;
  pokerUi.entry.hidden = Boolean(lobby);
  pokerUi.table.hidden = !lobby;
  if (!lobby) return;
  pokerUi.code.textContent = lobby.code;
  pokerUi.players.textContent = `Spieler: ${lobby.players.map(player => player.username).join(" · ")}${lobby.players.length < 2 ? " · Warte auf Mitspieler …" : ""}`;
  pokerUi.hand.hidden = !lobby.hand;
  pokerUi.start.hidden = lobby.hostId !== lobby.meId || lobby.status === "playing";
  pokerUi.start.disabled = pokerBusy || lobby.players.length !== 2;
  pokerUi.start.textContent = lobby.status === "finished" ? "Nächste Runde · 10 Chips" : "Runde starten · 10 Chips";
  const checked = lobby.hand?.checked.includes(lobby.meId);
  pokerUi.check.hidden = lobby.status !== "playing";
  pokerUi.fold.hidden = lobby.status !== "playing";
  pokerUi.check.disabled = pokerBusy || checked;
  pokerUi.fold.disabled = pokerBusy || checked;
  pokerUi.check.textContent = checked ? "Warte auf Mitspieler …" : "Schieben";
  if (!lobby.hand) {
    pokerUi.message.textContent = lobby.players.length < 2 ? "Teile den Lobby-Code mit einem Freund." : "Beide Spieler sind bereit. Der Host kann starten.";
    return;
  }
  pokerUi.street.textContent = {preflop:"Startkarten",flop:"Flop",turn:"Turn",river:"River"}[lobby.hand.street];
  pokerUi.pot.textContent = formatChips(lobby.hand.pot);
  pokerCards(pokerUi.board, lobby.hand.board);
  pokerCards(pokerUi.mine, lobby.hand.cards);
  pokerUi.opponent.replaceChildren();
  for (const [id, cards] of Object.entries(lobby.hand.opponentCards)) {
    const heading = document.createElement("span");
    heading.textContent = `${lobby.players.find(player => player.id === Number(id))?.username || "Mitspieler"}: `;
    const row = document.createElement("span");
    row.className = "poker-cards";
    pokerCards(row, cards);
    pokerUi.opponent.append(heading, row);
  }
  if (lobby.status === "finished") {
    const winner = lobby.players.find(player => player.id === lobby.hand.result?.winnerId);
    pokerUi.message.textContent = `${lobby.hand.result?.message || "Runde beendet."} ${winner ? `${winner.username} gewinnt ${formatChips(lobby.hand.pot)} Chips.` : ""}`;
  } else {
    pokerUi.message.textContent = checked ? "Du hast geschoben. Warte auf die andere Person." : "Schiebe oder passe. Nach beiden Aktionen geht es weiter.";
  }
  state.balance = lobby.balance;
  if (typeof updateControls === "function") updateControls();
}

async function loadPoker() {
  if (!state.token || state.activeView !== "poker" || pokerBusy || document.hidden) return;
  try {
    const data = await api("/api/poker/current");
    if (state.activeView === "poker") renderPoker(data.lobby);
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
  try {
    const data = await api(`/api/poker/${path}`, {method:"POST", body:JSON.stringify(payload)});
    renderPoker(data.lobby || null);
    if (path === "leave") pokerUi.message.textContent = "Du hast die Lobby verlassen.";
  } catch (error) {
    pokerUi.message.textContent = error.message;
  } finally {
    pokerBusy = false;
    if (pokerLobby) renderPoker(pokerLobby);
  }
}

pokerUi.create.addEventListener("click", () => pokerRequest("create"));
pokerUi.join.addEventListener("submit", event => {
  event.preventDefault();
  pokerRequest("join", {code:pokerUi.codeInput.value.trim()});
});
pokerUi.leave.addEventListener("click", () => pokerRequest("leave"));
pokerUi.start.addEventListener("click", () => pokerRequest("start"));
pokerUi.check.addEventListener("click", () => pokerRequest("action", {action:"check"}));
pokerUi.fold.addEventListener("click", () => pokerRequest("action", {action:"fold"}));
