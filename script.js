"use strict";

// Für das Deployment ausschließlich diese Adresse auf die HTTPS-API-Domain ändern.
const API_URL = "https://watt-casino-api.up.railway.app";
const TOKEN_KEY = "wattCasinoSessionToken";
const LEADERBOARD_LIMIT = 25;
const DEAL_DELAY = 210;

const ui = {
  authScreen: document.querySelector("#auth-screen"),
  app: document.querySelector("#casino-app"),
  loginTab: document.querySelector("#login-tab"),
  registerTab: document.querySelector("#register-tab"),
  loginForm: document.querySelector("#login-form"),
  registerForm: document.querySelector("#register-form"),
  loginMessage: document.querySelector("#login-message"),
  registerMessage: document.querySelector("#register-message"),
  headerUser: document.querySelector("#header-user"),
  logout: document.querySelector("#logout"),
  navLinks: [...document.querySelectorAll(".nav-link")],
  views: { game: document.querySelector("#game-view"), leaderboard: document.querySelector("#leaderboard-view") },
  balance: document.querySelector("#balance"),
  currentBet: document.querySelector("#current-bet"),
  dealerCards: document.querySelector("#dealer-cards"),
  playerCards: document.querySelector("#player-cards"),
  dealerScore: document.querySelector("#dealer-score"),
  playerScore: document.querySelector("#player-score"),
  message: document.querySelector("#game-message"),
  messageKicker: document.querySelector("#message-kicker"),
  messageText: document.querySelector("#message-text"),
  chips: [...document.querySelectorAll(".chip")],
  clearBet: document.querySelector("#clear-bet"),
  deal: document.querySelector("#deal"),
  hit: document.querySelector("#hit"),
  stand: document.querySelector("#stand"),
  double: document.querySelector("#double"),
  newRound: document.querySelector("#new-round"),
  leaderboardBody: document.querySelector("#leaderboard-body"),
  leaderboardEmpty: document.querySelector("#leaderboard-empty"),
  leaderboardStatus: document.querySelector("#leaderboard-status"),
  leaderboardPage: document.querySelector("#leaderboard-page"),
  leaderboardPrev: document.querySelector("#leaderboard-prev"),
  leaderboardNext: document.querySelector("#leaderboard-next"),
  profileDialog: document.querySelector("#profile-dialog"),
  profileClose: document.querySelector("#profile-close"),
  profileLoading: document.querySelector("#profile-loading"),
  profileContent: document.querySelector("#profile-content")
};

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  balance: 0,
  selectedBet: 0,
  round: null,
  busy: false,
  settled: false,
  activeView: "game",
  leaderboardPage: 1,
  leaderboardPages: 1,
  leaderboardTimer: null,
  leaderboardSignature: "",
  lastInteraction: Date.now(),
  heartbeatTimer: null
};

function formatChips(value) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1
  }).format(value ?? 0);
}

function formatPercent(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value ?? 0) + " %";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} Std. ${minutes} Min.`;
  return `${minutes} Min.`;
}

function actionId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error("Die Verbindung zum Watt-Casino-Server ist nicht verfügbar.");
  }

  let payload;
  try { payload = await response.json(); } catch { throw new Error("Der Server hat keine gültige Antwort geliefert."); }
  if (!response.ok || !payload.success) {
    if (response.status === 401 && state.token) clearSession();
    throw new Error(payload.message || "Die Anfrage konnte nicht verarbeitet werden.");
  }
  return payload.data;
}

function setFormMessage(element, message = "", success = false) {
  element.textContent = message;
  element.classList.toggle("is-success", success);
}

function setFormBusy(form, busy) {
  form.querySelector("button[type='submit']").disabled = busy;
  [...form.elements].forEach((element) => { if (element.tagName !== "BUTTON") element.disabled = busy; });
}

function switchAuthTab(tab) {
  const login = tab === "login";
  ui.loginTab.classList.toggle("is-active", login);
  ui.registerTab.classList.toggle("is-active", !login);
  ui.loginTab.setAttribute("aria-selected", String(login));
  ui.registerTab.setAttribute("aria-selected", String(!login));
  ui.loginForm.hidden = !login;
  ui.registerForm.hidden = login;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.user = null;
  state.round = null;
  state.balance = 0;
  state.selectedBet = 0;
  state.settled = false;
  stopLeaderboardPolling();
  stopHeartbeat();
  ui.app.hidden = true;
  ui.authScreen.hidden = false;
  switchAuthTab("login");
}

async function establishSession(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  const [me, current] = await Promise.all([api("/api/auth/me"), api("/api/game/current")]);
  state.user = me.user;
  state.balance = current.balance;
  state.round = current.round;
  state.selectedBet = current.round?.bet ?? 0;
  state.settled = false;
  ui.headerUser.textContent = state.user.username;
  ui.authScreen.hidden = true;
  ui.app.hidden = false;
  renderGame(false);
  startHeartbeat();
}

async function submitAuth(event, endpoint, form, messageElement) {
  event.preventDefault();
  if (form.dataset.busy === "true") return;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  setFormMessage(messageElement);
  form.dataset.busy = "true";
  setFormBusy(form, true);
  try {
    const data = await api(`/api/auth/${endpoint}`, { method: "POST", body: JSON.stringify({ username, password }) });
    await establishSession(data.token);
  } catch (error) {
    setFormMessage(messageElement, error.message);
  } finally {
    form.dataset.busy = "false";
    setFormBusy(form, false);
  }
}

function setMessage(kicker, text, tone = "neutral") {
  ui.messageKicker.textContent = kicker;
  ui.messageText.textContent = text;
  ui.message.dataset.tone = tone;
}

function cardElement(card, animate) {
  const element = document.createElement("div");
  element.className = `card${animate ? " dealt" : ""}${card.hidden ? " card--hidden" : ""}`;
  if (card.hidden) { element.setAttribute("aria-label", "Verdeckte Karte"); return element; }
  const red = card.suit === "♥" || card.suit === "♦";
  if (red) element.classList.add("red");
  element.setAttribute("aria-label", `${card.rank} ${card.suit}`);
  element.innerHTML = `<span class="card-corner"><span class="card-rank">${card.rank}</span><span class="card-suit-small">${card.suit}</span></span><span class="card-suit" aria-hidden="true">${card.suit}</span><span class="card-corner card-corner--bottom" aria-hidden="true"><span class="card-rank">${card.rank}</span><span class="card-suit-small">${card.suit}</span></span>`;
  return element;
}

async function renderCards(target, cards, animate) {
  target.replaceChildren();
  for (const card of cards) {
    target.append(cardElement(card, animate));
    if (animate) await new Promise((resolve) => setTimeout(resolve, DEAL_DELAY));
  }
}

async function renderGame(animate = false) {
  const round = state.round;
  ui.balance.textContent = formatChips(state.balance);
  ui.currentBet.textContent = formatChips(round?.bet ?? state.selectedBet);
  if (!round) {
    ui.playerCards.replaceChildren(); ui.dealerCards.replaceChildren();
    ui.playerScore.textContent = "–"; ui.dealerScore.textContent = "–";
    setMessage("Tisch geöffnet", state.balance > 0 ? "Einsatz wählen und Karten geben." : "Keine Chips verfügbar.", state.balance > 0 ? "neutral" : "loss");
    updateControls();
    return;
  }

  state.busy = animate;
  updateControls();
  await renderCards(ui.playerCards, round.playerCards, animate);
  await renderCards(ui.dealerCards, round.dealerCards, animate);
  ui.playerScore.textContent = round.playerValue;
  ui.dealerScore.textContent = round.dealerValue;
  state.busy = false;

  if (round.status === "completed") {
    state.settled = true;
    const result = round.result;
    const labels = { blackjack: "Blackjack", win: "Gewonnen", loss: "Runde verloren", push: "Unentschieden" };
    setMessage(labels[result.outcome], result.message, result.outcome === "loss" ? "loss" : result.outcome === "push" ? "neutral" : "win");
  } else {
    state.settled = false;
    setMessage("Ihre Entscheidung", "Karte nehmen, halten oder verdoppeln.");
  }
  updateControls();
}

function updateControls() {
  const isBetting = !state.round && !state.settled;
  const isPlaying = state.round?.status === "active";
  const available = state.balance - state.selectedBet;
  ui.chips.forEach((chip) => {
    const amount = chip.dataset.bet === "all" ? available : Number(chip.dataset.bet);
    chip.disabled = state.busy || !isBetting || amount <= 0 || amount > available;
  });
  ui.clearBet.disabled = state.busy || !isBetting || state.selectedBet === 0;
  ui.deal.disabled = state.busy || !isBetting || state.selectedBet < 5 || state.selectedBet > state.balance;
  const allowed = state.round?.allowedActions ?? [];
  ui.hit.disabled = state.busy || !isPlaying || !allowed.includes("hit");
  ui.stand.disabled = state.busy || !isPlaying || !allowed.includes("stand");
  ui.double.disabled = state.busy || !isPlaying || !allowed.includes("double");
  ui.newRound.disabled = state.busy || !state.settled;
}

function addBet(value) {
  if (state.busy || state.round || state.settled) return;
  const available = state.balance - state.selectedBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  state.selectedBet += amount;
  setMessage("Einsatz bereit", `${formatChips(state.selectedBet)} Chips liegen auf dem Tisch.`);
  updateControls();
  ui.currentBet.textContent = formatChips(state.selectedBet);
}

async function gameRequest(path, body = {}) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try {
    const data = await api(path, { method: "POST", body: JSON.stringify({ ...body, actionId: actionId() }) });
    state.balance = data.balance;
    state.round = data.round;
    state.selectedBet = data.round?.bet ?? 0;
    await renderGame(true);
    if (state.activeView === "leaderboard") loadLeaderboard();
  } catch (error) {
    state.busy = false;
    setMessage("Aktion nicht möglich", error.message, "loss");
    updateControls();
  }
}

function newRound() {
  if (state.busy || !state.settled) return;
  state.round = null;
  state.selectedBet = 0;
  state.settled = false;
  renderGame(false);
}

function setView(view) {
  state.activeView = view;
  Object.entries(ui.views).forEach(([name, element]) => { element.hidden = name !== view; });
  ui.navLinks.forEach((link) => link.classList.toggle("is-active", link.dataset.view === view));
  if (view === "leaderboard") { state.leaderboardPage = 1; loadLeaderboard(); startLeaderboardPolling(); }
  else stopLeaderboardPolling();
}

function statusOnline(online) {
  ui.leaderboardStatus.classList.toggle("is-offline", !online);
  ui.leaderboardStatus.querySelector("strong").textContent = online ? "Aktuell" : "Verbindung pausiert";
}

function updateLeaderboardRows(players) {
  const signature = JSON.stringify(players);
  if (signature === state.leaderboardSignature) return;
  state.leaderboardSignature = signature;
  const existing = new Map([...ui.leaderboardBody.rows].map((row) => [row.dataset.username, row]));
  const fragment = document.createDocumentFragment();
  for (const player of players) {
    let row = existing.get(player.username);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.username = player.username;
      row.innerHTML = "<td class='rank-cell'></td><td><button class='player-link' type='button'></button></td><td class='money-cell'></td><td></td><td></td>";
      row.querySelector(".player-link").addEventListener("click", () => openProfile(player.username));
    }
    row.classList.toggle("is-current", player.isCurrentUser);
    row.cells[0].textContent = player.rank;
    row.querySelector(".player-link").textContent = player.username;
    row.cells[1].querySelector(".you-badge")?.remove();
    if (player.isCurrentUser) { const badge = document.createElement("span"); badge.className = "you-badge"; badge.textContent = "Sie"; row.cells[1].append(badge); }
    row.cells[2].textContent = `${formatChips(player.balance)} Chips`;
    row.cells[3].textContent = player.roundsPlayed;
    row.cells[4].textContent = formatPercent(player.winRate);
    fragment.append(row);
  }
  ui.leaderboardBody.replaceChildren(fragment);
}

async function loadLeaderboard() {
  if (!state.token || state.activeView !== "leaderboard") return;
  try {
    const data = await api(`/api/leaderboard?page=${state.leaderboardPage}&limit=${LEADERBOARD_LIMIT}`);
    updateLeaderboardRows(data.players);
    ui.leaderboardEmpty.hidden = data.players.length > 0;
    state.leaderboardPage = data.pagination.page;
    state.leaderboardPages = data.pagination.totalPages;
    ui.leaderboardPage.textContent = `Seite ${state.leaderboardPage} von ${state.leaderboardPages}`;
    ui.leaderboardPrev.disabled = state.leaderboardPage <= 1;
    ui.leaderboardNext.disabled = state.leaderboardPage >= state.leaderboardPages;
    statusOnline(true);
  } catch {
    statusOnline(false);
  }
}

function stopLeaderboardPolling() { if (state.leaderboardTimer) clearTimeout(state.leaderboardTimer); state.leaderboardTimer = null; }
function startLeaderboardPolling() {
  stopLeaderboardPolling();
  const poll = async () => {
    await loadLeaderboard();
    if (state.activeView === "leaderboard") state.leaderboardTimer = setTimeout(poll, document.hidden ? 15000 : 2000);
  };
  state.leaderboardTimer = setTimeout(poll, document.hidden ? 15000 : 2000);
}

async function openProfile(username) {
  ui.profileContent.hidden = true;
  ui.profileLoading.hidden = false;
  if (!ui.profileDialog.open) ui.profileDialog.showModal();
  try {
    const { player } = await api(`/api/players/${encodeURIComponent(username)}`);
    const current = player.currentStreak;
    const streak = current.type === "win" ? `${current.count} Gewinn${current.count === 1 ? "" : "e"}` : current.type === "loss" ? `${current.count} Verlust${current.count === 1 ? "" : "e"}` : "Keine";
    ui.profileContent.innerHTML = `
      <div class="profile-identity"><div><h3 class="profile-name">${escapeHtml(player.username)}</h3><p class="profile-balance">${formatChips(player.balance)} Chips</p></div><span class="profile-rank">Rang ${player.rank}</span></div>
      <div class="profile-grid">
        ${profileStat("Gespielte Runden", player.roundsPlayed)}${profileStat("Gewonnen", player.wins)}${profileStat("Verloren", player.losses)}
        ${profileStat("Unentschieden", player.pushes)}${profileStat("Blackjacks", player.blackjacks)}${profileStat("Gewinnrate", formatPercent(player.winRate))}
        ${profileStat("Verlustquote", formatPercent(player.lossRate))}${profileStat("Höchster Stand", `${formatChips(player.highestBalance)} Chips`)}${profileStat("Größter Gewinn", `${formatChips(player.biggestWin)} Chips`)}
        ${profileStat("Virtueller Gewinn", `${formatChips(player.totalWon)} Chips`)}${profileStat("Virtueller Verlust", `${formatChips(player.totalLost)} Chips`)}${profileStat("Aktuelle Serie", streak)}
        ${profileStat("Beste Gewinnserie", player.bestWinStreak)}${profileStat("Spielzeit", formatDuration(player.totalPlaySeconds))}
      </div>
      <div class="profile-meta"><span>Registriert: <strong>${formatDate(player.registeredAt)}</strong></span><span>Letzte Aktivität: <strong>${formatDate(player.lastActivityAt)}</strong></span></div>`;
    ui.profileLoading.hidden = true;
    ui.profileContent.hidden = false;
  } catch (error) {
    ui.profileLoading.textContent = error.message;
  }
}

function profileStat(label, value) { return `<div class="profile-stat"><span>${label}</span><strong>${value}</strong></div>`; }
function escapeHtml(value) { const element = document.createElement("div"); element.textContent = value; return element.innerHTML; }

async function sendActivity(active) {
  if (!state.token) return;
  try { await api("/api/activity", { method: "POST", body: JSON.stringify({ active }) }); } catch { /* Aktivitätsfehler beeinflussen das Spiel nicht. */ }
}
function stopHeartbeat() { if (state.heartbeatTimer) clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
function startHeartbeat() {
  stopHeartbeat();
  sendActivity(true);
  state.heartbeatTimer = setInterval(() => {
    const active = !document.hidden && Date.now() - state.lastInteraction < 60_000;
    sendActivity(active);
  }, 30_000);
}

ui.loginTab.addEventListener("click", () => switchAuthTab("login"));
ui.registerTab.addEventListener("click", () => switchAuthTab("register"));
ui.loginForm.addEventListener("submit", (event) => submitAuth(event, "login", ui.loginForm, ui.loginMessage));
ui.registerForm.addEventListener("submit", (event) => submitAuth(event, "register", ui.registerForm, ui.registerMessage));
ui.logout.addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} clearSession(); });
ui.navLinks.forEach((link) => link.addEventListener("click", () => setView(link.dataset.view)));
ui.chips.forEach((chip) => chip.addEventListener("click", () => addBet(chip.dataset.bet)));
ui.clearBet.addEventListener("click", () => { state.selectedBet = 0; renderGame(false); });
ui.deal.addEventListener("click", () => gameRequest("/api/game/start", { bet: state.selectedBet }));
ui.hit.addEventListener("click", () => gameRequest("/api/game/hit"));
ui.stand.addEventListener("click", () => gameRequest("/api/game/stand"));
ui.double.addEventListener("click", () => gameRequest("/api/game/double"));
ui.newRound.addEventListener("click", newRound);
ui.leaderboardPrev.addEventListener("click", () => { if (state.leaderboardPage > 1) { state.leaderboardPage -= 1; state.leaderboardSignature = ""; loadLeaderboard(); } });
ui.leaderboardNext.addEventListener("click", () => { if (state.leaderboardPage < state.leaderboardPages) { state.leaderboardPage += 1; state.leaderboardSignature = ""; loadLeaderboard(); } });
ui.profileClose.addEventListener("click", () => ui.profileDialog.close());
ui.profileDialog.addEventListener("click", (event) => { if (event.target === ui.profileDialog) ui.profileDialog.close(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { sendActivity(false); } else { state.lastInteraction = Date.now(); sendActivity(true); if (state.activeView === "leaderboard") startLeaderboardPolling(); } });
["click", "keydown", "pointerdown", "touchstart"].forEach((eventName) => document.addEventListener(eventName, () => { state.lastInteraction = Date.now(); }, { passive: true }));

if (state.token) {
  establishSession(state.token).catch((error) => { clearSession(); setFormMessage(ui.loginMessage, error.message); });
}
