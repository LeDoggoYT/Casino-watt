"use strict";
ui.views.crash = document.querySelector("#crash-view");
const crashUI = Object.fromEntries(["balance", "history", "chips", "bet", "clear", "submit", "message", "form", "players", "previous", "player-count", "round-label", "connection", "fill", "line", "dot", "axis-top", "axis-time", "phase", "multiplier", "countdown"].map(id => [id, document.querySelector(`#crash-${id}`)]));
let crashSelectedBet = 0;
let crashData = null;
let crashReceivedAt = 0;
let crashTimer = null;
let crashFrame = null;
let crashRequestBusy = false;
let crashActionBusy = false;
let crashOwner = null;
let crashError = "";
const crashFormat = value => `${value.toLocaleString("de-DE", {minimumFractionDigits: 2, maximumFractionDigits: 2})}×`;

function crashConnected() { return crashData && performance.now() - crashReceivedAt < 3500 && !crashError; }
function updateCrashControls() {
  if (crashSelectedBet > state.balance) crashSelectedBet = 0;
  const mine = crashData?.mine;
  const phase = crashData?.round.phase;
  const locked = state.busy || crashActionBusy || Boolean(mine);
  const available = state.balance - crashSelectedBet;
  crashUI.balance.textContent = formatChips(state.balance);
  crashUI.bet.textContent = formatChips(mine?.bet ?? crashSelectedBet);
  crashUI.chips.querySelectorAll("button").forEach(chip => {
    const amount = chip.dataset.crashBet;
    chip.disabled = locked || (amount === "custom" ? available < 5 : amount === "all" ? available <= 0 : Number(amount) > available);
  });
  crashUI.clear.disabled = locked || !crashSelectedBet;
  const canCashout = phase === "running" && mine && mine.payout === null;
  crashUI.submit.disabled = !crashConnected() || state.busy || crashActionBusy || (!canCashout && !(phase === "waiting" && !mine && crashSelectedBet >= 5));
  crashUI.submit.classList.toggle("is-cashout", Boolean(canCashout));
  crashUI.submit.textContent = crashActionBusy ? "Wird bestätigt …" : canCashout ? "Jetzt aussteigen" : mine?.payout != null ? "Runde abgeschlossen" : mine ? "Einsatz gesetzt" : phase === "waiting" ? "Einsatz setzen" : "Nächste Runde abwarten";
}
function addCrashBet(value) {
  if (state.busy || crashActionBusy || crashData?.mine) return;
  if (value === "custom") { openCustomBet("crash"); return; }
  const available = state.balance - crashSelectedBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  crashSelectedBet += amount;
  updateCrashControls();
}
ui.chips.forEach(chip => {
  const copy = chip.cloneNode(true);
  copy.dataset.crashBet = copy.dataset.bet;
  delete copy.dataset.bet;
  copy.addEventListener("click", () => addCrashBet(copy.dataset.crashBet));
  crashUI.chips.append(copy);
});
crashUI.clear.addEventListener("click", () => { crashSelectedBet = 0; updateCrashControls(); });

function renderCrashPlayers(target, players) {
  target.replaceChildren();
  if (!players.length) { const empty = document.createElement("p"); empty.className = "crash-list-hint"; empty.textContent = "Noch keine Einsätze."; target.append(empty); return; }
  for (const player of players) {
    const row = document.createElement("div"); row.className = "crash-player";
    const name = document.createElement("strong"); name.textContent = player.username + (player.mine ? " · Du" : "");
    const bet = document.createElement("span"); bet.textContent = `${formatChips(player.bet)} Chips`;
    const result = document.createElement("span");
    result.className = player.net === null ? "is-pending" : player.net >= 0 ? "is-positive" : "is-negative";
    result.textContent = player.net === null ? "Im Spiel" : `${player.net >= 0 ? "+" : ""}${formatChips(player.net)} Chips`;
    if (player.cashout_at) result.title = `Ausgestiegen bei ${crashFormat(player.cashout_at)}`;
    row.append(name, bet, result); target.append(row);
  }
}
function applyCrashData(data) {
  if (crashData && data.serverTime < crashData.serverTime) return;
  crashData = data; crashReceivedAt = performance.now(); crashError = "";
  state.balance = data.balance;
  ui.balance.textContent = formatChips(data.balance);
  crashUI.history.replaceChildren();
  for (const round of data.history) {
    const badge = document.createElement("span"); badge.className = round.crash_at >= 2 ? "is-high" : "";
    badge.textContent = crashFormat(round.crash_at); badge.title = `Runde ${round.id}`; crashUI.history.append(badge);
  }
  if (!data.history.length) crashUI.history.textContent = "Die erste Runde startet gleich.";
  renderCrashPlayers(crashUI.players, data.players);
  renderCrashPlayers(crashUI.previous, data.previous);
  crashUI["player-count"].textContent = data.players.length;
  crashUI["round-label"].textContent = `Runde #${data.round.id}`;
  const mine = data.mine;
  crashUI.message.textContent = mine?.payout != null ? (mine.cashout_at ? `Bei ${crashFormat(mine.cashout_at)} ausgestiegen: ${formatChips(mine.payout)} Chips ausgezahlt.` : `${formatChips(mine.bet)} Chips verloren.`) : mine ? "Dein Einsatz ist gesetzt. Steige rechtzeitig aus." : "Einsatz vor dem Start setzen und vor dem Crash aussteigen.";
  updateCrashControls();
}
async function pollCrash() {
  clearTimeout(crashTimer);
  if (state.activeView !== "crash" || !state.token || document.hidden) return;
  if (crashRequestBusy || crashActionBusy) { crashTimer = setTimeout(pollCrash, 500); return; }
  crashRequestBusy = true;
  const token = state.token;
  try {
    const data = await api("/api/crash/current", {signal: AbortSignal.timeout(8000)});
    if (state.token === token && state.activeView === "crash") applyCrashData(data);
  } catch (error) { crashError = error.message; crashUI.message.textContent = error.message; updateCrashControls(); }
  finally { crashRequestBusy = false; crashTimer = setTimeout(pollCrash, 1000); }
}
function drawCrash() {
  if (state.activeView !== "crash" || !state.token || document.hidden) { crashFrame = null; return; }
  if (crashData) {
    const round = crashData.round;
    const connected = crashConnected();
    const delta = Math.min((performance.now() - crashReceivedAt) / 1000, 1.25);
    const elapsed = Math.max(0, crashData.serverTime - round.startsAt + (round.phase === "running" && connected ? delta : 0));
    const value = round.phase === "running" ? Math.exp(elapsed * .09) : round.multiplier;
    const chartTime = round.phase === "crashed" ? Math.log(value)/.09 : elapsed;
    const maxTime = Math.max(12, chartTime + 1);
    const maxValue = Math.max(2, value * 1.12);
    let curve = "M60 440";
    let x = 60, y = 440;
    for (let i = 1; i <= 60; i++) {
      const t = chartTime * i / 60;
      x = 60 + t / maxTime * 700;
      y = 440 - (Math.exp(t * .09) - 1) / (maxValue - 1) * 390;
      curve += ` L${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    crashUI.line.setAttribute("d", curve);
    crashUI.fill.setAttribute("d", `${curve} L${x} 440 Z`);
    crashUI.dot.setAttribute("cx", x); crashUI.dot.setAttribute("cy", y);
    crashUI["axis-top"].textContent = `${maxValue.toFixed(1)}×`;
    crashUI["axis-time"].textContent = `${Math.floor(chartTime)} s`;
    crashUI.multiplier.textContent = crashFormat(value);
    crashUI.phase.textContent = !connected ? "Verbindung unterbrochen" : round.phase === "waiting" ? "Nächste Runde" : round.phase === "crashed" ? "CRASH" : "Runde läuft";
    crashUI.countdown.textContent = round.phase === "running" ? "Rechtzeitig aussteigen" : `${round.phase === "waiting" ? "Start" : "Neue Runde"} in ${Math.max(0, Math.ceil(round.nextIn - delta))} s`;
    crashUI.connection.textContent = connected ? "● Live · Server verbunden" : "Verbindung wird wiederhergestellt …";
    ui.views.crash.classList.toggle("is-crashed", round.phase === "crashed");
    if (!connected) crashUI.submit.disabled = true;
  }
  crashFrame = requestAnimationFrame(drawCrash);
}
function startCrash() {
  if (crashOwner !== state.token) { crashData = null; crashSelectedBet = 0; crashOwner = state.token; }
  updateCrashControls();
  pollCrash();
  if (crashFrame === null) drawCrash();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.activeView === "crash") startCrash(); });
crashUI.form.addEventListener("submit", async event => {
  event.preventDefault();
  if (crashActionBusy || state.busy || !crashConnected()) return;
  const token = state.token;
  const roundId = crashData.round.id;
  const action = crashData.round.phase === "running" && crashData.mine?.payout === null ? "cashout" : "bet";
  crashActionBusy = true; state.busy = true;
  clearTimeout(crashTimer);
  updateCrashControls();
  try {
    const data = await api(`/api/crash/${action}`, {method: "POST", signal: AbortSignal.timeout(8000), body: JSON.stringify({roundId, actionId: actionId(), bet: crashSelectedBet})});
    if (state.token !== token) return;
    if (action === "bet") crashSelectedBet = 0;
    applyCrashData(data);
  } catch (error) { crashUI.message.textContent = error.message; }
  finally { crashActionBusy = false; state.busy = false; updateCrashControls(); updateControls(); pollCrash(); }
});
