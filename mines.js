"use strict";
const minesUI = Object.fromEntries(["balance", "chips", "bet", "clear", "count", "minus", "plus", "start", "cashout", "gems", "risk", "opened", "payout", "message", "grid", "multipliers"].map(id => [id, document.querySelector(`#mines-${id}`)]));
let minesSelectedBet = 0;
let minesCount = 3;
let minesRound = null;
let minesResult = null;
let minesBusy = false;
let minesOwner = null;

function minesMultiplier(mines, opened) {
  if (!opened) return 1;
  let value = .97;
  for (let index = 0; index < opened; index++) value *= (25 - index) / (25 - mines - index);
  return value;
}
function minesError(message) {
  minesUI.message.textContent = message;
  minesUI.message.classList.remove("visually-hidden");
  minesUI.message.hidden = false;
}
function updateMinesControls() {
  syncChipValues();
  if (!minesRound && minesSelectedBet > state.balance) minesSelectedBet = 0;
  const locked = minesBusy || state.busy || Boolean(minesRound);
  const available = state.balance - minesSelectedBet;
  minesUI.balance.textContent = formatChips(state.balance);
  minesUI.bet.textContent = formatChips(minesRound?.bet ?? minesSelectedBet);
  for (const chip of minesUI.chips.children) {
    const value = chip.dataset.minesBet;
    chip.disabled = locked || (value === "custom" ? available < 5 : value === "all" ? available <= 0 : Number(value) > available);
  }
  minesUI.clear.disabled = locked || !minesSelectedBet;
  minesUI.minus.disabled = locked || minesCount <= 1;
  minesUI.plus.disabled = locked || minesCount >= 20;
  document.querySelectorAll("[data-mines-count]").forEach(button => {
    button.disabled = locked;
    button.classList.toggle("is-active", Number(button.dataset.minesCount) === minesCount);
  });
  minesUI.start.hidden = Boolean(minesRound);
  minesUI.start.disabled = locked || minesSelectedBet < 5;
  minesUI.cashout.hidden = !minesRound;
  minesUI.cashout.disabled = minesBusy || state.busy || !minesRound?.revealed.length;
  minesUI.count.textContent = minesRound?.mineCount ?? minesCount;
}
function addMinesBet(value) {
  if (minesRound || minesBusy || state.busy) return;
  if (value === "custom") return openCustomBet("mines");
  const available = state.balance - minesSelectedBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  minesSelectedBet += amount;
  updateMinesControls();
}
for (const chip of ui.chips) {
  const copy = chip.cloneNode(true);
  copy.dataset.minesBet = copy.dataset.bet;
  delete copy.dataset.bet;
  copy.addEventListener("click", () => addMinesBet(copy.dataset.minesBet));
  minesUI.chips.append(copy);
}
minesUI.clear.addEventListener("click", () => { minesSelectedBet = 0; updateMinesControls(); });
function setMinesCount(value) {
  if (minesRound || minesBusy || state.busy) return;
  minesCount = Math.max(1, Math.min(20, value));
  renderMines();
}
minesUI.minus.addEventListener("click", () => setMinesCount(minesCount - 1));
minesUI.plus.addEventListener("click", () => setMinesCount(minesCount + 1));
document.querySelectorAll("[data-mines-count]").forEach(button => button.addEventListener("click", () => setMinesCount(Number(button.dataset.minesCount))));

function renderMines() {
  const opened = minesRound?.revealed ?? minesResult?.revealed ?? [];
  const count = minesRound?.mineCount ?? minesCount;
  const mines = new Set(minesResult?.mines ?? []);
  minesUI.grid.replaceChildren();
  for (let index = 0; index < 25; index++) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "mines-tile";
    const isGem = opened.includes(index);
    const isMine = minesResult && mines.has(index);
    if (isGem) { tile.classList.add("is-gem"); tile.textContent = "◆"; }
    else if (isMine) { tile.classList.add(index === minesResult.tile ? "is-hit" : "is-mine"); tile.textContent = "✹"; }
    tile.disabled = minesBusy || state.busy || !minesRound || isGem;
    tile.setAttribute("aria-label", `Feld ${index + 1}: ${isGem ? "Diamant" : isMine ? "Mine" : "verdeckt"}`);
    if (minesRound && !isGem) tile.addEventListener("click", () => minesAction("reveal", {tile: index}));
    minesUI.grid.append(tile);
  }
  minesUI.multipliers.replaceChildren();
  const limit = Math.min(7, 25 - count);
  for (let step = 1; step <= limit; step++) {
    const badge = document.createElement("span");
    badge.textContent = `${minesMultiplier(count, step).toFixed(2).replace(".", ",")}×`;
    if (step === opened.length) badge.classList.add("is-current");
    minesUI.multipliers.append(badge);
  }
  minesUI.gems.textContent = opened.length;
  minesUI.opened.textContent = `${opened.length} / 25`;
  minesUI.risk.textContent = `${Math.round(count / (25 - opened.length) * 100)} %`;
  minesUI.payout.textContent = formatChips(minesRound?.payout ?? minesResult?.payout ?? 0);
  updateMinesControls();
}
async function loadMines() {
  if (!state.token || minesBusy) return;
  const token = state.token;
  if (minesOwner !== token) { minesRound = null; minesResult = null; minesSelectedBet = 0; }
  minesOwner = token;
  try {
    const data = await api("/api/mines/current", {signal: AbortSignal.timeout(8000)});
    if (state.token !== token) return;
    minesRound = data.round;
    minesResult = data.result;
    if (minesRound) minesCount = minesRound.mineCount;
    else if (minesResult) minesCount = minesResult.mineCount;
    state.balance = data.balance;
    updateControls();
    minesUI.message.hidden = true;
    renderMines();
  } catch (error) { if (state.token === token) minesError(error.message); }
}
async function minesAction(action, extra = {}) {
  if (minesBusy || state.busy) return;
  const token = state.token;
  minesBusy = true;
  minesUI.message.hidden = true;
  minesUI.message.classList.remove("visually-hidden");
  updateMinesControls();
  try {
    const data = await api(`/api/mines/${action}`, {method: "POST", signal: AbortSignal.timeout(10000), body: JSON.stringify({actionId: actionId(), ...extra})});
    if (state.token !== token) return;
    minesRound = data.round;
    minesResult = data.result;
    state.balance = data.balance;
    if (action === "start") minesSelectedBet = 0;
    updateControls();
    renderMines();
    if (data.result) {
      minesUI.message.textContent = data.result.won ? `${formatChips(data.result.payout)} Chips ausgezahlt.` : "Mine getroffen. Einsatz verloren.";
      minesUI.message.classList.add("visually-hidden");
      minesUI.message.hidden = false;
    }
  } catch (error) {
    if (state.token !== token) return;
    minesError(error.message);
    // A lost response can occur after the server has completed the action.
    if (["TimeoutError", "AbortError", "TypeError"].includes(error.name)) {
      minesBusy = false;
      await loadMines();
    }
  } finally { minesBusy = false; updateMinesControls(); renderMines(); }
}
minesUI.start.addEventListener("click", () => minesAction("start", {bet: minesSelectedBet, mineCount: minesCount}));
minesUI.cashout.addEventListener("click", () => minesAction("cashout"));
renderMines();
