"use strict";
ui.views.slots = document.querySelector("#slots-view");
const slotFace = ["🍒", "🍋", "🔔", "💎", "7️⃣"];
const reels = [...document.querySelectorAll(".slot-reel")];
const slotChips = document.querySelector("#slots-chips");
const slotStatus = document.querySelector("#slots-status");
function showSlotsError(message) {
  slotStatus.textContent = message;
  slotStatus.classList.remove("visually-hidden");
  slotStatus.hidden = false;
}
let slotsBet = 0;

function updateSlotsControls() {
  syncChipValues();
  if (slotsBet > state.balance) slotsBet = 0;
  const available = state.balance - slotsBet;
  document.querySelector("#slots-balance").textContent = formatChips(state.balance);
  document.querySelector("#slots-bet").textContent = formatChips(slotsBet);
  for (const chip of slotChips.children) {
    const value = chip.dataset.slotBet;
    chip.disabled = state.busy || (value === "custom" ? available < 5 : value === "all" ? available <= 0 : Number(value) > available);
  }
  document.querySelector("#slots-clear").disabled = state.busy || !slotsBet;
  document.querySelector("#slots-spin").disabled = state.busy || slotsBet < 5;
}
function addSlotsBet(value) {
  if (state.busy) return;
  if (value === "custom") return openCustomBet("slots");
  const available = state.balance - slotsBet;
  const amount = value === "all" ? available : Number(value);
  if (!(amount > 0 && amount <= available)) return;
  slotsBet += amount;
  updateSlotsControls();
}
for (const chip of ui.chips) {
  const copy = chip.cloneNode(true);
  copy.dataset.slotBet = copy.dataset.bet;
  delete copy.dataset.bet;
  copy.addEventListener("click", () => addSlotsBet(copy.dataset.slotBet));
  slotChips.append(copy);
}
document.querySelector("#slots-clear").onclick = () => { slotsBet = 0; updateSlotsControls(); };

async function stopSlotReel(reel, symbol, index) {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && reel.animate) {
    const strip = document.createElement("div");
    const faces = [reel.textContent, ...slotFace, ...slotFace.slice(0, index+1), slotFace[symbol]];
    for (const face of faces) {
      const cell = document.createElement("span");
      cell.textContent = face;
      strip.append(cell);
    }
    reel.replaceChildren(strip);
    try {
      await strip.animate([{transform:"translateY(0)"}, {transform:`translateY(calc(-100% + 100% / ${faces.length}))`}],
        {duration:650 + index*270, easing:"cubic-bezier(.15,.65,.24,1)", fill:"forwards"}).finished;
    } finally { reel.textContent = slotFace[symbol]; }
  } else reel.textContent = slotFace[symbol];
}
document.querySelector("#slots-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy || slotsBet < 5 || slotsBet > state.balance) return;
  const token = state.token;
  state.busy = true;
  updateSlotsControls();
  slotStatus.textContent = "";
  slotStatus.classList.remove("visually-hidden");
  slotStatus.hidden = true;
  try {
    const result = await api("/api/slots/play", {method:"POST", body:JSON.stringify({bet:slotsBet, actionId:actionId()}), signal:AbortSignal.timeout(10000)});
    if (state.token !== token) return;
    state.balance = result.balance;
    slotsBet = 0;
    await Promise.all(reels.map((reel,i) => stopSlotReel(reel,result.symbols[i],i)));
    if (state.token !== token) return;
    slotStatus.textContent = result.multiplier === 1 ? "Einsatz zurück." : result.multiplier ? `${result.multiplier}× · ${formatChips(result.payout)} Chips ausgezahlt.` : "Kein Gewinn.";
    slotStatus.classList.add("visually-hidden");
    slotStatus.hidden = false;
  } catch (error) {
    if (state.token !== token) return;
    showSlotsError(error.message);
    try {
      const current = await api("/api/auth/me", {signal:AbortSignal.timeout(8000)});
      if (state.token === token) state.balance = current.game.balance;
    } catch { /* The next session refresh loads the balance. */ }
  } finally {
    state.busy = false;
    if (state.token === token) ui.balance.textContent = formatChips(state.balance);
    updateSlotsControls(); updateControls();
  }
});
