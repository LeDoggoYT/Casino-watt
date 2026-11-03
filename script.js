"use strict";

// Let the intro finish once; focus changes must neither stop nor restart it.
(() => {
  const intro = document.querySelector(".casino-intro");
  if (!intro) return;
  let fallback;
  const dismiss = () => {
    intro.remove();
    clearTimeout(fallback);
  };
  intro.addEventListener("animationend", event => {
    if (event.target === intro && event.animationName === "casino-intro-exit") dismiss();
  });
  fallback = setTimeout(dismiss, 2500);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) dismiss();
})();

// Für das Deployment ausschließlich diese Adresse auf die HTTPS-API-Domain ändern.
// Öffentliche PythonAnywhere-API für das Netlify-Frontend.
const API_URL = "https://ledoggo.pythonanywhere.com";
const TOKEN_KEY = "wattCasinoSessionToken";
const LEADERBOARD_LIMIT = 25;
const LEADERBOARD_POLL_MS = 30_000;
const ACTIVITY_PING_MS = 120_000;
const DEAL_STAGGER = 95;
const CARD_ANIMATION_MS = 240;

const ui = {
  authScreen: document.querySelector("#auth-screen"),
  suspendedScreen: document.querySelector("#suspended-screen"),
  suspensionReason: document.querySelector("#suspension-reason-text"),
  suspendedLogout: document.querySelector("#suspended-logout"),
  app: document.querySelector("#casino-app"),
  loginTab: document.querySelector("#login-tab"),
  registerTab: document.querySelector("#register-tab"),
  loginForm: document.querySelector("#login-form"),
  registerForm: document.querySelector("#register-form"),
  loginMessage: document.querySelector("#login-message"),
  registerMessage: document.querySelector("#register-message"),
  headerUser: document.querySelector("#header-user"),
  homeBalance: document.querySelector("#home-balance"),
  headerAvatar: document.querySelector("#header-avatar"),
  avatarOpen: document.querySelector("#avatar-open"),
  avatarDialog: document.querySelector("#avatar-dialog"),
  avatarClose: document.querySelector("#avatar-close"),
  avatarCancel: document.querySelector("#avatar-cancel"),
  avatarInput: document.querySelector("#avatar-input"),
  avatarPicker: document.querySelector("#avatar-picker"),
  avatarReselect: document.querySelector("#avatar-reselect"),
  avatarSave: document.querySelector("#avatar-save"),
  avatarError: document.querySelector("#avatar-error"),
  cropEditor: document.querySelector("#crop-editor"),
  cropCanvas: document.querySelector("#crop-canvas"),
  cropZoom: document.querySelector("#crop-zoom"),
  logout: document.querySelector("#logout"),
  navLinks: [...document.querySelectorAll(".nav-link")],
  views: { home: document.querySelector("#home-view"), game: document.querySelector("#game-view"), poker: document.querySelector("#poker-view"), chicken: document.querySelector("#chicken-view"), mines: document.querySelector("#mines-view"), leaderboard: document.querySelector("#leaderboard-view"), upgrades: document.querySelector("#upgrades-view") },
  chickenBalance: document.querySelector("#chicken-balance"),
  chickenBet: document.querySelector("#chicken-bet"),
  chickenChips: document.querySelector("#chicken-chips"),
  chickenClearBet: document.querySelector("#chicken-clear-bet"),
  chickenStart: document.querySelector("#chicken-start"),
  chickenStep: document.querySelector("#chicken-step"),
  chickenCashout: document.querySelector("#chicken-cashout"),
  chickenMessage: document.querySelector("#chicken-message"),
  chickenPayout: document.querySelector("#chicken-payout"),
  chickenPath: [...document.querySelectorAll(".chicken-path li")],
  chickenActor: document.querySelector("#chicken-actor"),
  chickenRoad: document.querySelector("#chicken-road"),
  chickenRoadScroll: document.querySelector("#chicken-road-scroll"),
  chickenLanes: [...document.querySelectorAll(".chicken-lane")],
  chickenImpactCar: document.querySelector("#chicken-impact-car"),
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
  profileContent: document.querySelector("#profile-content"),
  upgradeBalance: document.querySelector("#upgrade-balance"),
  upgradeGrid: document.querySelector("#upgrade-grid"),
  upgradeLoading: document.querySelector("#upgrade-loading"),
  upgradesMessage: document.querySelector("#upgrades-message"),
  dailyBonusTitle: document.querySelector("#daily-bonus-title"),
  dailyBonusStatus: document.querySelector("#daily-bonus-status"),
  dailyBonusClaim: document.querySelector("#daily-bonus-claim"),
  customBetDialog: document.querySelector("#custom-bet-dialog"),
  customBetForm: document.querySelector("#custom-bet-form"),
  customBetInput: document.querySelector("#custom-bet-input"),
  customBetError: document.querySelector("#custom-bet-error"),
  customBetClose: document.querySelector("#custom-bet-close"),
  customBetCancel: document.querySelector("#custom-bet-cancel")
};
ui.chips.filter(chip => /^\d+$/.test(chip.dataset.bet)).forEach((chip, index) => { chip.dataset.chipIndex = index; });

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  balance: 0,
  selectedBet: 0,
  round: null,
  chickenRound: null,
  chickenResult: null,
  chickenBet: 0,
  customBetGame: "game",
  busy: false,
  settled: false,
  activeView: "home",
  leaderboardPage: 1,
  leaderboardPages: 1,
  leaderboardTimer: null,
  leaderboardSignature: "",
  lastInteraction: Date.now(),
  heartbeatTimer: null,
  upgrades: null,
  sessionRetryTimer: null,
  avatarCrop: { image: null, zoom: 1, x: 0, y: 0, baseScale: 1, dragging: false, pointerX: 0, pointerY: 0 }
};

function formatChips(value) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1
  }).format(value ?? 0);
}

const CHIP_DENOMINATIONS = Array.from({length: 16}, (_, power) => [1, 2, 5].map(part => part * 10 ** power))
  .flat().filter(value => value >= 5 && Number.isSafeInteger(value));
function chipLabel(value) {
  if (value >= 1_000_000_000) return `${value / 1_000_000_000}Mrd`;
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}
function syncChipValues() {
  const target = Math.max(5, state.balance / 200);
  const start = Math.max(0, CHIP_DENOMINATIONS.findLastIndex(value => value <= target));
  const keys = ["bet", "chickenBet", "slotBet", "pinballBet", "crashBet", "minesBet"];
  document.querySelectorAll(".chip[data-chip-index]").forEach(chip => {
    const value = CHIP_DENOMINATIONS[Math.min(start + Number(chip.dataset.chipIndex), CHIP_DENOMINATIONS.length - 1)];
    const key = keys.find(name => Object.hasOwn(chip.dataset, name));
    if (!key) return;
    chip.dataset[key] = String(value);
    chip.querySelector("span").textContent = chipLabel(value);
    chip.setAttribute("aria-label", `${formatChips(value)} Chips setzen`);
    chip.title = `${formatChips(value)} Chips`;
  });
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
  const headers = { ...(options.headers ?? {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
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
    if (response.status === 403 && payload.data?.suspended) {
      showSuspended(payload.data.reason);
      const error = new Error(payload.message || "Dieses Spielerkonto wurde gesperrt.");
      error.suspended = true;
      throw error;
    }
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
  state.chickenRound = null;
  state.chickenResult = null;
  state.chickenBet = 0;
  state.balance = 0;
  state.selectedBet = 0;
  state.settled = false;
  state.upgrades = null;
  if (state.sessionRetryTimer) clearTimeout(state.sessionRetryTimer);
  state.sessionRetryTimer = null;
  stopLeaderboardPolling();
  stopHeartbeat();
  if (typeof stopPoker === "function") stopPoker();
  ui.app.hidden = true;
  document.querySelector("#admin-link").hidden = true;
  ui.suspendedScreen.hidden = true;
  ui.authScreen.hidden = false;
  ui.headerAvatar.replaceChildren();
  switchAuthTab("login");
}

function showSuspended(reason) {
  stopLeaderboardPolling();
  stopHeartbeat();
  ui.authScreen.hidden = true;
  ui.app.hidden = true;
  ui.suspensionReason.textContent = reason || "Kein Grund angegeben.";
  ui.suspendedScreen.hidden = false;
}

async function establishSession(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
  // Profil und ggf. laufende Runde kommen in einer einzigen Anfrage zurück.
  const me = await api("/api/auth/me");
  const current = me.game;
  state.user = me.user;
  state.balance = current.balance;
  state.round = current.round;
  state.selectedBet = current.round?.bet ?? 0;
  state.settled = false;
  ui.headerUser.textContent = state.user.username;
  document.querySelector("#admin-link").hidden = !me.adminAccess;
  renderAvatar(ui.headerAvatar, state.user);
  ui.authScreen.hidden = true;
  ui.suspendedScreen.hidden = true;
  ui.app.hidden = false;
  setView("home");
  setFormMessage(ui.loginMessage);
  if (state.sessionRetryTimer) clearTimeout(state.sessionRetryTimer);
  state.sessionRetryTimer = null;
  renderGame(false);
  startHeartbeat();
}

function resumeCachedSession() {
  if (!state.token || state.user) return;
  establishSession(state.token).catch((error) => {
    if (error.suspended || !state.token) return;
    setFormMessage(ui.loginMessage, `${error.message} Erneuter Versuch läuft automatisch.`);
    if (state.sessionRetryTimer) clearTimeout(state.sessionRetryTimer);
    state.sessionRetryTimer = setTimeout(resumeCachedSession, 10_000);
  });
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
  element.dataset.cardSignature = card.hidden ? "hidden" : `${card.rank}:${card.suit}`;
  if (card.hidden) { element.setAttribute("aria-label", "Verdeckte Karte"); return element; }
  const red = card.suit === "♥" || card.suit === "♦";
  if (red) element.classList.add("red");
  element.setAttribute("aria-label", `${card.rank} ${card.suit}`);
  element.innerHTML = `<span class="card-corner"><span class="card-rank">${card.rank}</span><span class="card-suit-small">${card.suit}</span></span><span class="card-suit" aria-hidden="true">${card.suit}</span><span class="card-corner card-corner--bottom" aria-hidden="true"><span class="card-rank">${card.rank}</span><span class="card-suit-small">${card.suit}</span></span>`;
  return element;
}

function avatarSource(avatarUrl) {
  return avatarUrl ? `${API_URL}${avatarUrl}` : "";
}

function initials(username) {
  return (username || "?").trim().slice(0, 1).toUpperCase();
}

function renderAvatar(target, player) {
  target.replaceChildren();
  const source = avatarSource(player?.avatarUrl);
  if (source) {
    const image = document.createElement("img");
    image.src = source;
    image.alt = "";
    image.addEventListener("error", () => { image.remove(); target.textContent = initials(player?.username); });
    target.append(image);
  } else {
    target.textContent = initials(player?.username);
  }
}

function resetAvatarEditor() {
  state.avatarCrop.image = null;
  state.avatarCrop.zoom = 1;
  state.avatarCrop.x = 0;
  state.avatarCrop.y = 0;
  ui.cropZoom.value = "1";
  ui.avatarInput.value = "";
  ui.avatarError.textContent = "";
  ui.avatarPicker.hidden = false;
  ui.cropEditor.hidden = true;
  ui.avatarSave.disabled = true;
}

function openAvatarEditor() {
  resetAvatarEditor();
  ui.avatarDialog.showModal();
}

function closeAvatarEditor() {
  state.avatarCrop.dragging = false;
  ui.avatarDialog.close();
  resetAvatarEditor();
}

function clampCropPosition() {
  const crop = state.avatarCrop;
  if (!crop.image) return;
  const width = crop.image.naturalWidth * crop.baseScale * crop.zoom;
  const height = crop.image.naturalHeight * crop.baseScale * crop.zoom;
  crop.x = Math.min(0, Math.max(ui.cropCanvas.width - width, crop.x));
  crop.y = Math.min(0, Math.max(ui.cropCanvas.height - height, crop.y));
}

function drawAvatarCrop() {
  const crop = state.avatarCrop;
  if (!crop.image) return;
  clampCropPosition();
  const context = ui.cropCanvas.getContext("2d");
  context.clearRect(0, 0, ui.cropCanvas.width, ui.cropCanvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const scale = crop.baseScale * crop.zoom;
  context.drawImage(crop.image, crop.x, crop.y, crop.image.naturalWidth * scale, crop.image.naturalHeight * scale);
}

function setCropZoom(nextZoom) {
  const crop = state.avatarCrop;
  if (!crop.image) return;
  const previousWidth = crop.image.naturalWidth * crop.baseScale * crop.zoom;
  const previousHeight = crop.image.naturalHeight * crop.baseScale * crop.zoom;
  const centerX = (ui.cropCanvas.width / 2 - crop.x) / previousWidth;
  const centerY = (ui.cropCanvas.height / 2 - crop.y) / previousHeight;
  crop.zoom = Number(nextZoom);
  const width = crop.image.naturalWidth * crop.baseScale * crop.zoom;
  const height = crop.image.naturalHeight * crop.baseScale * crop.zoom;
  crop.x = ui.cropCanvas.width / 2 - centerX * width;
  crop.y = ui.cropCanvas.height / 2 - centerY * height;
  drawAvatarCrop();
}

function prepareAvatarFile(file) {
  if (!file) return;
  ui.avatarError.textContent = "";
  if (!/^(image\/png|image\/jpeg|image\/webp)$/.test(file.type) || file.size > 2 * 1024 * 1024) {
    ui.avatarError.textContent = "Bitte ein PNG-, JPG- oder WebP-Bild bis 2 MB auswählen.";
    return;
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  image.onload = () => {
    URL.revokeObjectURL(objectUrl);
    const crop = state.avatarCrop;
    crop.image = image;
    crop.zoom = 1;
    crop.baseScale = Math.max(ui.cropCanvas.width / image.naturalWidth, ui.cropCanvas.height / image.naturalHeight);
    const width = image.naturalWidth * crop.baseScale;
    const height = image.naturalHeight * crop.baseScale;
    crop.x = (ui.cropCanvas.width - width) / 2;
    crop.y = (ui.cropCanvas.height - height) / 2;
    ui.cropZoom.value = "1";
    ui.avatarPicker.hidden = true;
    ui.cropEditor.hidden = false;
    ui.avatarSave.disabled = false;
    drawAvatarCrop();
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    ui.avatarError.textContent = "Das ausgewählte Bild konnte nicht geöffnet werden.";
  };
  image.src = objectUrl;
}

async function saveCroppedAvatar() {
  if (!state.avatarCrop.image || ui.avatarSave.disabled) return;
  ui.avatarSave.disabled = true;
  ui.avatarSave.textContent = "Wird gespeichert …";
  ui.avatarError.textContent = "";
  try {
    const blob = await new Promise((resolve, reject) => {
      ui.cropCanvas.toBlob((result) => result ? resolve(result) : reject(new Error("Der Zuschnitt konnte nicht erstellt werden.")), "image/jpeg", 0.9);
    });
    const formData = new FormData();
    formData.append("avatar", blob, "profilbild.jpg");
    const data = await api("/api/profile/avatar", { method: "POST", body: formData });
    state.user.avatarUrl = data.avatarUrl + "?v=" + Date.now();
    renderAvatar(ui.headerAvatar, state.user);
    state.leaderboardSignature = "";
    if (state.activeView === "leaderboard") loadLeaderboard();
    closeAvatarEditor();
    setMessage("Profilbild aktualisiert", "Ihr Bild wird jetzt im Leaderboard angezeigt.", "win");
  } catch (error) {
    ui.avatarError.textContent = error.message;
  } finally {
    ui.avatarSave.textContent = "Profilbild speichern";
    ui.avatarSave.disabled = !state.avatarCrop.image;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function dealInitialCards(playerCards, dealerCards) {
  ui.playerCards.replaceChildren();
  ui.dealerCards.replaceChildren();
  const sequence = [
    [ui.playerCards, playerCards[0]],
    [ui.dealerCards, dealerCards[0]],
    [ui.playerCards, playerCards[1]],
    [ui.dealerCards, dealerCards[1]]
  ].filter(([, card]) => card);

  for (let index = 0; index < sequence.length; index += 1) {
    const [target, card] = sequence[index];
    target.append(cardElement(card, true));
    if (index < sequence.length - 1) await wait(DEAL_STAGGER);
  }
  if (sequence.length) await wait(CARD_ANIMATION_MS);
}

async function reconcileCards(target, cards, animate) {
  let animatedChanges = 0;

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const signature = card.hidden ? "hidden" : `${card.rank}:${card.suit}`;
    const existing = target.children[index];

    if (existing?.dataset.cardSignature === signature) continue;

    const replacement = cardElement(card, animate && !existing);
    if (existing) {
      replacement.classList.add("card--revealed");
      existing.replaceWith(replacement);
    } else {
      target.append(replacement);
    }
    animatedChanges += animate ? 1 : 0;
    if (animate && index < cards.length - 1) await wait(DEAL_STAGGER);
  }

  while (target.children.length > cards.length) {
    target.lastElementChild.remove();
  }

  if (animatedChanges) await wait(CARD_ANIMATION_MS);
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
  const isInitialDeal = animate && ui.playerCards.children.length === 0 && ui.dealerCards.children.length === 0;
  if (isInitialDeal) {
    await dealInitialCards(round.playerCards, round.dealerCards);
  } else {
    await reconcileCards(ui.playerCards, round.playerCards, animate);
    await reconcileCards(ui.dealerCards, round.dealerCards, animate);
  }
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
    setMessage(round.notice ? "Glück aktiviert" : "Ihre Entscheidung", round.notice || "Karte nehmen, halten oder verdoppeln.", round.notice ? "win" : "neutral");
  }
  updateControls();
}

function updateControls() {
  syncChipValues();
  ui.homeBalance.textContent = formatChips(state.balance);
  const isBetting = !state.round && !state.settled;
  const isPlaying = state.round?.status === "active";
  const available = state.balance - state.selectedBet;
  ui.chips.forEach((chip) => {
    const amount = chip.dataset.bet === "all" ? available : chip.dataset.bet === "custom" ? 5 : Number(chip.dataset.bet);
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
  if (value === "custom") {
    openCustomBet();
    return;
  }
  const available = state.balance - state.selectedBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  state.selectedBet += amount;
  setMessage("Einsatz bereit", `${formatChips(state.selectedBet)} Chips liegen auf dem Tisch.`);
  updateControls();
  ui.currentBet.textContent = formatChips(state.selectedBet);
}

function openCustomBet(game = "game") {
  state.customBetGame = game;
  const available = state.balance - (game === "slots" ? slotsBet : game === "crash" ? crashSelectedBet : game === "pinball" ? pinballSelectedBet : game === "mines" ? minesSelectedBet : game === "chicken" ? state.chickenBet : state.selectedBet);
  if (available < 5) return;
  ui.customBetInput.max = String(available);
  ui.customBetInput.value = String(Math.min(available, 100));
  ui.customBetError.textContent = "";
  ui.customBetDialog.showModal();
  ui.customBetInput.focus();
  ui.customBetInput.select();
}

function submitCustomBet(event) {
  event.preventDefault();
  const available = state.balance - (state.customBetGame === "slots" ? slotsBet : state.customBetGame === "crash" ? crashSelectedBet : state.customBetGame === "pinball" ? pinballSelectedBet : state.customBetGame === "mines" ? minesSelectedBet : state.customBetGame === "chicken" ? state.chickenBet : state.selectedBet);
  const amount = Number(ui.customBetInput.value.replace?.(",", ".") ?? ui.customBetInput.value);
  if (!Number.isFinite(amount) || amount < 5 || amount > available || amount * 2 !== Math.round(amount * 2)) {
    ui.customBetError.textContent = `Bitte einen Betrag zwischen 5 und ${formatChips(available)} in 0,5er-Schritten eingeben.`;
    return;
  }
  ui.customBetDialog.close();
  if (state.customBetGame === "crash") addCrashBet(String(amount));
  else if (state.customBetGame === "slots") addSlotsBet(String(amount));
  else if (state.customBetGame === "pinball") addPinballBet(String(amount));
  else if (state.customBetGame === "mines") addMinesBet(String(amount));
  else if (state.customBetGame === "chicken") addChickenBet(String(amount));
  else addBet(String(amount));
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
  if (!ui.views[view]) return;
  if (view === "home") ui.homeBalance.textContent = formatChips(state.balance);
  if (state.activeView === "poker" && view !== "poker" && typeof stopPoker === "function") stopPoker();
  state.activeView = view;
  Object.entries(ui.views).forEach(([name, element]) => { element.hidden = name !== view; });
  ui.navLinks.forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (view === "leaderboard") { state.leaderboardPage = 1; loadLeaderboard(); startLeaderboardPolling(); }
  else stopLeaderboardPolling();
  if (view === "upgrades") loadUpgrades();
  if (view === "chicken") loadChicken();
  if (view === "slots") updateSlotsControls();
  if (view === "pinball") { updatePinballControls(); loadPinballConfig(); }
  if (view === "mines") loadMines();
  if (view === "crash") startCrash();
  if (view === "loot") loadLoot();
  if (view === "market") loadMarket();
  if (view === "poker" && typeof startPoker === "function") startPoker();
}

function positionChicken(step) {
  const position = (step + .5) / (ui.chickenLanes.length + 2);
  ui.chickenActor.style.left = `${position * 100}%`;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ui.chickenRoadScroll.scrollTo({ left: Math.max(0, ui.chickenRoad.clientWidth * position - ui.chickenRoadScroll.clientWidth * .35), behavior: reduced ? "instant" : "smooth" });
}

async function animateChickenStep(data) {
  const lost = data.result?.won === false;
  const step = lost ? data.result.steps + 1 : data.round?.steps ?? data.result?.steps ?? 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, reduced ? 0 : ms));
  ui.chickenLanes[step - 1]?.classList.add("is-crossing");
  ui.chickenActor.classList.add("is-walking");
  positionChicken(step);
  await pause(220);
  ui.chickenActor.classList.remove("is-walking");
  if (lost) {
    ui.chickenImpactCar.style.left = `${(step + .5) / (ui.chickenLanes.length + 2) * 100}%`;
    ui.chickenImpactCar.classList.add("is-hitting");
    await pause(180);
    ui.chickenActor.classList.add("is-crashed");
    await pause(150);
  } else if (step === ui.chickenLanes.length) {
    positionChicken(step + 1);
    await pause(220);
  }
}

function updateChickenControls() {
  syncChipValues();
  const locked = Boolean(state.chickenRound) || state.busy;
  if (!state.chickenRound && state.chickenBet > state.balance) state.chickenBet = 0;
  const available = state.balance - state.chickenBet;
  ui.chickenBet.textContent = formatChips(state.chickenRound?.bet ?? state.chickenBet);
  ui.chickenChips.querySelectorAll("button").forEach((chip) => {
    const value = chip.dataset.chickenBet;
    chip.disabled = locked || (value === "custom" ? available < 5 : value === "all" ? available <= 0 : Number(value) > available);
  });
  ui.chickenClearBet.disabled = locked || state.chickenBet === 0;
  ui.chickenStart.disabled = state.busy || state.chickenBet < 5 || state.chickenBet > state.balance;
  ui.chickenStep.disabled = state.busy;
  ui.chickenCashout.disabled = state.busy;
}

function addChickenBet(value) {
  if (state.busy || state.chickenRound) return;
  if (value === "custom") { openCustomBet("chicken"); return; }
  const available = state.balance - state.chickenBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  state.chickenBet += amount;
  updateChickenControls();
}

function renderChicken(result = state.chickenResult) {
  const round = state.chickenRound;
  ui.chickenBalance.textContent = formatChips(state.balance);
  ui.chickenStart.hidden = Boolean(round);
  ui.chickenStep.hidden = !round;
  ui.chickenCashout.hidden = !round || round.steps === 0;
  updateChickenControls();
  const steps = round?.steps ?? result?.steps ?? 0;
  ui.chickenPath.forEach((item, index) => item.classList.toggle("is-complete", index < steps));
  ui.chickenLanes.forEach((lane, index) => {
    lane.classList.toggle("is-safe", index < steps);
    lane.classList.toggle("is-crossing", result?.won === false && index === steps);
  });
  ui.chickenActor.classList.toggle("is-crashed", result?.won === false);
  ui.chickenActor.classList.toggle("is-winner", result?.won === true);
  if (!result) ui.chickenImpactCar.classList.remove("is-hitting");
  positionChicken(result?.won === false ? steps + 1 : steps === ui.chickenLanes.length ? steps + 1 : steps);
  ui.chickenPayout.textContent = formatChips(round?.payout ?? result?.payout ?? 0);
  if (result) {
    ui.chickenMessage.textContent = result.won
      ? `${result.steps} Schritte geschafft. ${formatChips(result.payout)} Chips ausgezahlt.`
      : `${formatChips(-result.netResult)} Chips verloren.`;
    ui.chickenMessage.classList.add("visually-hidden");
    ui.chickenMessage.hidden = false;
  } else {
    ui.chickenMessage.textContent = "";
    ui.chickenMessage.hidden = true;
  }
}

async function loadChicken() {
  if (state.busy) return;
  state.busy = true;
  renderChicken();
  try {
    const data = await api("/api/chicken/current");
    state.chickenRound = data.round;
    if (data.round) state.chickenResult = null;
    state.balance = data.balance;
    ui.balance.textContent = formatChips(data.balance);
    renderChicken();
  } catch (error) { ui.chickenMessage.textContent = error.message; ui.chickenMessage.classList.remove("visually-hidden"); ui.chickenMessage.hidden = false; }
  finally {
    state.busy = false;
    updateChickenControls();
    updateControls();
  }
}

async function chickenRequest(action) {
  if (state.busy) return;
  const bet = state.chickenBet;
  if (action === "start" && (!Number.isFinite(bet) || bet < 5 || bet * 2 !== Math.round(bet * 2) || bet > state.balance)) {
    ui.chickenMessage.textContent = `Bitte 5 bis ${formatChips(state.balance)} Chips in 0,5er-Schritten setzen.`;
    ui.chickenMessage.classList.remove("visually-hidden");
    ui.chickenMessage.hidden = false;
    return;
  }
  state.busy = true;
  renderChicken();
  try {
    const data = await api(`/api/chicken/${action}`, { method: "POST", body: JSON.stringify({ actionId: actionId(), ...(action === "start" ? { bet } : {}) }) });
    if (action === "step") await animateChickenStep(data);
    state.chickenRound = data.round;
    state.chickenResult = data.result;
    if (data.result) state.chickenBet = 0;
    state.balance = data.balance;
    ui.balance.textContent = formatChips(data.balance);
    if (!state.round && state.selectedBet > data.balance) state.selectedBet = 0;
    ui.currentBet.textContent = formatChips(state.round?.bet ?? state.selectedBet);
    renderChicken(data.result);
  } catch (error) {
    state.busy = false;
    renderChicken();
    ui.chickenMessage.textContent = error.message;
    ui.chickenMessage.classList.remove("visually-hidden");
    ui.chickenMessage.hidden = false;
  }
  finally {
    state.busy = false;
    updateChickenControls();
    updateControls();
  }
}

function renderUpgrades(data) {
  state.upgrades = data;
  state.balance = data.balance;
  if (!state.round && state.selectedBet > state.balance) state.selectedBet = 0;
  ui.balance.textContent = formatChips(state.balance);
  ui.currentBet.textContent = formatChips(state.round?.bet ?? state.selectedBet);
  updateControls();
  ui.upgradeBalance.textContent = formatChips(data.balance);
  ui.upgradeLoading.hidden = true;
  const cards = document.createDocumentFragment();
  for (const upgrade of data.upgrades) {
    const card = document.createElement("article");
    card.className = "upgrade-card";
    const maxed = upgrade.level >= upgrade.maxLevel;
    card.innerHTML = `<div class="upgrade-card-top"><div><span class="section-kicker">Level ${upgrade.level} / ${upgrade.maxLevel}</span><h2>${escapeHtml(upgrade.name)}</h2></div><span class="upgrade-level">${upgrade.level}</span></div><p>${escapeHtml(upgrade.effect)}</p><div class="upgrade-progress" aria-label="${upgrade.level} von ${upgrade.maxLevel} Leveln"><span style="width:${(upgrade.level / upgrade.maxLevel) * 100}%"></span></div><button type="button" ${maxed || !upgrade.canBuy ? "disabled" : ""}>${maxed ? "Maximallevel" : `${formatChips(upgrade.price)} Chips`}</button>`;
    if (!maxed) card.querySelector("button").addEventListener("click", () => buyUpgrade(upgrade.key));
    cards.append(card);
  }
  ui.upgradeGrid.replaceChildren(cards);

  const dailyLevel = data.upgrades.find((upgrade) => upgrade.key === "daily_bonus")?.level ?? 0;
  if (!dailyLevel) {
    ui.dailyBonusTitle.textContent = "Tagesbonus nicht freigeschaltet";
    ui.dailyBonusStatus.textContent = "Kaufe das Tagesbonus-Upgrade, um täglich Chips abzuholen.";
  } else if (data.roundActive) {
    ui.dailyBonusTitle.textContent = "Runde zuerst abschließen";
    ui.dailyBonusStatus.textContent = "Käufe und Tagesbonus sind während einer laufenden Runde pausiert.";
  } else if (data.dailyBonus.available) {
    ui.dailyBonusTitle.textContent = `${formatChips(data.dailyBonus.amount)} Chips sind bereit`;
    ui.dailyBonusStatus.textContent = "Deine tägliche Belohnung kann jetzt abgeholt werden.";
  } else {
    ui.dailyBonusTitle.textContent = "Tagesbonus bereits abgeholt";
    ui.dailyBonusStatus.textContent = `Wieder verfügbar: ${formatDate(data.dailyBonus.nextClaimAt)}`;
  }
  ui.dailyBonusClaim.disabled = data.roundActive || !data.dailyBonus.available;
}

async function loadUpgrades() {
  if (!state.token || state.activeView !== "upgrades") return;
  ui.upgradeLoading.hidden = Boolean(state.upgrades);
  try {
    renderUpgrades(await api("/api/upgrades"));
  } catch (error) {
    ui.upgradeLoading.hidden = false;
    ui.upgradeLoading.textContent = error.message;
  }
}

async function buyUpgrade(key) {
  if (state.busy) return;
  state.busy = true;
  ui.upgradesMessage.textContent = "Upgrade wird gekauft …";
  try {
    const data = await api(`/api/upgrades/${encodeURIComponent(key)}/buy`, { method: "POST", body: JSON.stringify({ actionId: actionId() }) });
    renderUpgrades(data);
    ui.upgradesMessage.textContent = "Upgrade erfolgreich verbessert.";
  } catch (error) {
    ui.upgradesMessage.textContent = error.message;
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function claimDailyBonus() {
  if (state.busy || ui.dailyBonusClaim.disabled) return;
  state.busy = true;
  ui.dailyBonusClaim.disabled = true;
  try {
    const data = await api("/api/upgrades/daily-bonus/claim", { method: "POST", body: JSON.stringify({ actionId: actionId() }) });
    renderUpgrades(data);
    ui.upgradesMessage.textContent = `${formatChips(data.dailyBonus.amount)} Chips Tagesbonus wurden gutgeschrieben.`;
  } catch (error) {
    ui.upgradesMessage.textContent = error.message;
  } finally {
    state.busy = false;
    updateControls();
  }
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
      row.innerHTML = "<td class='rank-cell'></td><td><button class='player-link' type='button'><span class='avatar avatar--leaderboard'></span><span class='player-link-name'></span></button></td><td class='money-cell'></td><td></td><td></td>";
      row.querySelector(".player-link").addEventListener("click", () => openProfile(player.username));
    }
    row.classList.toggle("is-current", player.isCurrentUser);
    row.cells[0].textContent = player.rank;
    renderAvatar(row.querySelector(".avatar"), player);
    row.querySelector(".player-link-name").textContent = player.username;
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
    if (state.activeView === "leaderboard" && !document.hidden) state.leaderboardTimer = setTimeout(poll, LEADERBOARD_POLL_MS);
  };
  if (!document.hidden) state.leaderboardTimer = setTimeout(poll, LEADERBOARD_POLL_MS);
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
      <div class="profile-identity"><div class="profile-player"><span class="avatar avatar--profile" data-profile-avatar></span><div><h3 class="profile-name">${escapeHtml(player.username)}</h3><p class="profile-balance">${formatChips(player.balance)} Chips</p></div></div><span class="profile-rank">Rang ${player.rank}</span></div>
      <div class="profile-grid">
        ${profileStat("Gespielte Runden", player.roundsPlayed)}${profileStat("Gewonnen", player.wins)}${profileStat("Verloren", player.losses)}
        ${profileStat("Unentschieden", player.pushes)}${profileStat("Blackjacks", player.blackjacks)}${profileStat("Gewinnrate", formatPercent(player.winRate))}
        ${profileStat("Verlustquote", formatPercent(player.lossRate))}${profileStat("Höchster Stand", `${formatChips(player.highestBalance)} Chips`)}${profileStat("Größter Gewinn", `${formatChips(player.biggestWin)} Chips`)}
        ${profileStat("Virtueller Gewinn", `${formatChips(player.totalWon)} Chips`)}${profileStat("Virtueller Verlust", `${formatChips(player.totalLost)} Chips`)}${profileStat("Aktuelle Serie", streak)}
        ${profileStat("Beste Gewinnserie", player.bestWinStreak)}${profileStat("Spielzeit", formatDuration(player.totalPlaySeconds))}
      </div>
      <div class="profile-meta"><span>Registriert: <strong>${formatDate(player.registeredAt)}</strong></span><span>Letzte Aktivität: <strong>${formatDate(player.lastActivityAt)}</strong></span></div>`;
    renderAvatar(ui.profileContent.querySelector("[data-profile-avatar]"), player);
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
  }, ACTIVITY_PING_MS);
}

ui.loginTab.addEventListener("click", () => switchAuthTab("login"));
ui.registerTab.addEventListener("click", () => switchAuthTab("register"));
ui.loginForm.addEventListener("submit", (event) => submitAuth(event, "login", ui.loginForm, ui.loginMessage));
ui.registerForm.addEventListener("submit", (event) => submitAuth(event, "register", ui.registerForm, ui.registerMessage));
ui.logout.addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} clearSession(); });
ui.avatarOpen.addEventListener("click", openAvatarEditor);
ui.avatarClose.addEventListener("click", closeAvatarEditor);
ui.avatarCancel.addEventListener("click", closeAvatarEditor);
ui.avatarDialog.addEventListener("click", (event) => { if (event.target === ui.avatarDialog) closeAvatarEditor(); });
ui.avatarInput.addEventListener("change", () => prepareAvatarFile(ui.avatarInput.files?.[0]));
ui.avatarReselect.addEventListener("click", () => ui.avatarInput.click());
ui.avatarSave.addEventListener("click", saveCroppedAvatar);
ui.cropZoom.addEventListener("input", () => setCropZoom(ui.cropZoom.value));
ui.cropCanvas.addEventListener("pointerdown", (event) => {
  if (!state.avatarCrop.image) return;
  state.avatarCrop.dragging = true;
  state.avatarCrop.pointerX = event.clientX;
  state.avatarCrop.pointerY = event.clientY;
  ui.cropCanvas.setPointerCapture(event.pointerId);
});
ui.cropCanvas.addEventListener("pointermove", (event) => {
  const crop = state.avatarCrop;
  if (!crop.dragging) return;
  const rect = ui.cropCanvas.getBoundingClientRect();
  crop.x += (event.clientX - crop.pointerX) * (ui.cropCanvas.width / rect.width);
  crop.y += (event.clientY - crop.pointerY) * (ui.cropCanvas.height / rect.height);
  crop.pointerX = event.clientX;
  crop.pointerY = event.clientY;
  drawAvatarCrop();
});
["pointerup", "pointercancel"].forEach((eventName) => ui.cropCanvas.addEventListener(eventName, () => { state.avatarCrop.dragging = false; }));
ui.suspendedLogout.addEventListener("click", clearSession);
ui.navLinks.forEach((link) => link.addEventListener("click", () => setView(link.dataset.view)));
ui.chips.forEach((chip) => {
  const copy = chip.cloneNode(true);
  copy.dataset.chickenBet = copy.dataset.bet;
  delete copy.dataset.bet;
  copy.addEventListener("click", () => addChickenBet(copy.dataset.chickenBet));
  ui.chickenChips.append(copy);
});
ui.chickenClearBet.addEventListener("click", () => { state.chickenBet = 0; updateChickenControls(); });
ui.chickenStart.addEventListener("click", () => chickenRequest("start"));
ui.chickenStep.addEventListener("click", () => chickenRequest("step"));
ui.chickenCashout.addEventListener("click", () => chickenRequest("cashout"));
document.querySelectorAll("[data-view-link], [data-open-view]").forEach((link) => link.addEventListener("click", (event) => {
  if (link.matches("a")) event.preventDefault();
  setView(link.dataset.viewLink || link.dataset.openView);
}));
ui.chips.forEach((chip) => chip.addEventListener("click", () => addBet(chip.dataset.bet)));
ui.clearBet.addEventListener("click", () => { state.selectedBet = 0; renderGame(false); });
ui.deal.addEventListener("click", () => gameRequest("/api/game/start", { bet: state.selectedBet }));
ui.hit.addEventListener("click", () => gameRequest("/api/game/hit"));
ui.stand.addEventListener("click", () => gameRequest("/api/game/stand"));
ui.double.addEventListener("click", () => gameRequest("/api/game/double"));
ui.newRound.addEventListener("click", newRound);
ui.customBetForm.addEventListener("submit", submitCustomBet);
ui.customBetClose.addEventListener("click", () => ui.customBetDialog.close());
ui.customBetCancel.addEventListener("click", () => ui.customBetDialog.close());
ui.customBetDialog.addEventListener("click", (event) => { if (event.target === ui.customBetDialog) ui.customBetDialog.close(); });
ui.dailyBonusClaim.addEventListener("click", claimDailyBonus);
ui.leaderboardPrev.addEventListener("click", () => { if (state.leaderboardPage > 1) { state.leaderboardPage -= 1; state.leaderboardSignature = ""; loadLeaderboard(); } });
ui.leaderboardNext.addEventListener("click", () => { if (state.leaderboardPage < state.leaderboardPages) { state.leaderboardPage += 1; state.leaderboardSignature = ""; loadLeaderboard(); } });
ui.profileClose.addEventListener("click", () => ui.profileDialog.close());
ui.profileDialog.addEventListener("click", (event) => { if (event.target === ui.profileDialog) ui.profileDialog.close(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { stopLeaderboardPolling(); sendActivity(false); } else { state.lastInteraction = Date.now(); sendActivity(true); if (state.activeView === "leaderboard") { loadLeaderboard(); startLeaderboardPolling(); } } });
["click", "keydown", "pointerdown", "touchstart"].forEach((eventName) => document.addEventListener(eventName, () => { state.lastInteraction = Date.now(); }, { passive: true }));

if (state.token) resumeCachedSession();

// Start with the server cursor so opening the site never replays old wins.
let bigWinCursor = null;
async function pollBigWins() {
  try {
    if (document.hidden) { bigWinCursor = null; return; }
    const query = bigWinCursor === null ? "" : `?after=${bigWinCursor}`;
    const response = await fetch(`${API_URL}/api/big-wins${query}`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload.success || !Array.isArray(payload.data?.wins)) return;
    bigWinCursor = payload.data.cursor;
    const container = document.querySelector("#win-notifications");
    for (const win of payload.data.wins) {
      const toast = document.createElement("div");
      toast.className = "win-notification";
      const title = document.createElement("span");
      title.className = "win-notification__title";
      title.textContent = `Großer Gewinn · ${win.game}`;
      const player = document.createElement("strong");
      player.textContent = win.username;
      const amount = document.createElement("span");
      amount.className = "win-notification__amount";
      amount.textContent = `+${formatChips(win.amount)} Chips gewonnen`;
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Mitteilung schließen");
      close.addEventListener("click", () => toast.remove());
      toast.append(title, player, amount, close);
      container.append(toast);
      while (container.children.length > 3) container.firstElementChild.remove();
      setTimeout(() => toast.remove(), 8000);
    }
  } catch { /* A feed outage must not interrupt a game. */ }
  finally { setTimeout(pollBigWins, 10000); }
}
pollBigWins();
