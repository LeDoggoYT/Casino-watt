"use strict";
ui.views.pinball = document.querySelector("#pinball-view");
const pinballSvg = document.querySelector("#pinball-board");
const pinballSlots = document.querySelector("#pinball-slots");
const pinballBet = document.querySelector("#pinball-bet");
let pinballSelectedBet = 0;
function updatePinballControls() {
  if (pinballSelectedBet > state.balance) pinballSelectedBet = 0;
  pinballBet.textContent = formatChips(pinballSelectedBet);
  document.querySelector("#pinball-balance").textContent = formatChips(state.balance);
  const available = state.balance - pinballSelectedBet;
  document.querySelectorAll("#pinball-chips button").forEach(chip => {
    const value = chip.dataset.pinballBet;
    chip.disabled = state.busy || (value === "custom" ? available < 5 : value === "all" ? available <= 0 : Number(value) > available);
  });
  document.querySelector("#pinball-clear-bet").disabled = state.busy || !pinballSelectedBet;
  document.querySelector("#pinball-play").disabled = state.busy || pinballSelectedBet < 5;
}
function addPinballBet(value) {
  if (state.busy) return;
  if (value === "custom") { openCustomBet("pinball"); return; }
  const available = state.balance - pinballSelectedBet;
  const amount = value === "all" ? available : Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) return;
  pinballSelectedBet += amount;
  updatePinballControls();
}
ui.chips.forEach(chip => {
  const copy = chip.cloneNode(true);
  copy.dataset.pinballBet = copy.dataset.bet;
  delete copy.dataset.bet;
  copy.addEventListener("click", () => addPinballBet(copy.dataset.pinballBet));
  document.querySelector("#pinball-chips").append(copy);
});
document.querySelector("#pinball-clear-bet").addEventListener("click", () => { pinballSelectedBet = 0; updatePinballControls(); });
const pinballForm = document.querySelector("#pinball-form");
const pinballMessage = document.querySelector("#pinball-message");
const pinballMultipliers = [200, 74, 12, 3.6, 1.5, .8, .6, .8, 1.5, 3.6, 12, 74, 200];
function pinballCircle(x, y, radius, className) {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [key, value] of Object.entries({ cx: x, cy: y, r: radius, class: className })) circle.setAttribute(key, value);
  pinballSvg.append(circle);
  return circle;
}
for (let row = 0; row < pinballMultipliers.length - 1; row++) {
  for (let col = 0; col < row + 3; col++) pinballCircle(300 + (col - (row + 2) / 2) * 40, 55 + row * 40, 4.5, "pinball-peg");
}
pinballMultipliers.forEach((value, index) => {
  const slot = document.createElement("span");
  slot.textContent = `${String(value).replace(".", ",")}×`;
  slot.style.setProperty("--slot-color", `hsl(${Math.min(index, 12 - index) * 9} 78% 55%)`);
  pinballSlots.append(slot);
});
const pinballBall = pinballCircle(300, 20, 8, "pinball-ball");
function launchPinball() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    pinballBall.setAttribute("cy", 47);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    function frame(now) {
      const progress = Math.min((now - start) / 350, 1);
      pinballBall.setAttribute("cy", 20 + 27 * progress * progress);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}
function pinballTargetX(slot) {
  const board = pinballSvg.getBoundingClientRect();
  const target = pinballSlots.children[slot].getBoundingClientRect();
  const view = pinballSvg.viewBox.baseVal;
  // A hidden view has zero width (e.g. when navigating during a drop).
  // Keep valid SVG coordinates until the board is visible again.
  if (board.width <= 0 || target.width <= 0) return view.x + (slot + .5) / pinballMultipliers.length * view.width;
  return view.x + (target.left + target.width / 2 - board.left) / board.width * view.width;
}
async function animatePinball(path, slot) {
  let x = 300;
  const points = [{ x, y: 47 }];
  path.forEach((direction, index) => { x += direction ? 20 : -20; points.push({ x, y: 87 + index * 40 }); });
  // Use the actual field centre, including CSS gaps and responsive sizing.
  points.push({ x: pinballTargetX(slot), y: 550 });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    await new Promise(resolve => {
      const start = performance.now();
      function frame(now) {
        points[points.length - 1].x = pinballTargetX(slot);
        const position = Math.min((now - start) / 180, points.length - 1);
        const index = Math.min(Math.floor(position), points.length - 2);
        const t = position - index;
        pinballBall.setAttribute("cx", points[index].x + (points[index + 1].x - points[index].x) * t);
        pinballBall.setAttribute("cy", points[index].y + (points[index + 1].y - points[index].y) * t - Math.sin(t * Math.PI) * 10);
        if (position < points.length - 1) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
  }
  pinballBall.setAttribute("cx", pinballTargetX(slot));
  pinballBall.setAttribute("cy", 550);
}
pinballForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy) return;
  const bet = pinballSelectedBet;
  if (!Number.isFinite(bet) || bet < 5 || bet > state.balance || bet * 2 !== Math.round(bet * 2)) { pinballMessage.textContent = "Bitte einen gültigen Einsatz innerhalb deines Guthabens wählen."; return; }
  pinballBall.setAttribute("cx", 300);
  pinballBall.setAttribute("cy", 20);
  state.busy = true;
  const token = state.token;
  [...pinballForm.elements].forEach(element => { element.disabled = true; });
  [...pinballSlots.children].forEach(slot => slot.classList.remove("is-hit"));
  pinballMessage.textContent = "Die Kugel fällt …";
  let launch = Promise.resolve();
  try {
    launch = launchPinball();
    const data = await api("/api/pinball/play", { method: "POST", signal: AbortSignal.timeout(10000), body: JSON.stringify({ bet, actionId: actionId() }) });
    if (state.token !== token) return;
    state.balance = data.balance;
    pinballSelectedBet = 0;
    if (!Array.isArray(data.path) || data.path.some(step => step !== 0 && step !== 1) ||
        !Number.isInteger(data.slot) || data.slot < 0 || data.slot >= pinballMultipliers.length ||
        data.path.length !== pinballMultipliers.length - 1 ||
        data.path.reduce((sum, step) => sum + step, 0) !== data.slot ||
        pinballMultipliers[data.slot] !== data.multiplier ||
        (data.multipliers && data.multipliers.some((value, index) => value !== pinballMultipliers[index]))) {
      ui.balance.textContent = formatChips(data.balance);
      await launch;
      pinballBall.setAttribute("cx", 300);
      pinballBall.setAttribute("cy", 20);
      pinballMessage.textContent = `${formatChips(data.payout)} Chips ausgezahlt. Spielversionen stimmen nicht überein: Backend aktualisieren und Seite neu laden.`;
      return;
    }
    await launch;
    await animatePinball(data.path, data.slot);
    if (state.token !== token) return;
    pinballSlots.children[data.slot].classList.add("is-hit");
    document.querySelector("#pinball-balance").textContent = formatChips(data.balance);
    ui.balance.textContent = formatChips(data.balance);
    pinballMessage.textContent = `${data.multiplier}× · ${formatChips(data.payout)} Chips ausgezahlt (${data.netResult >= 0 ? "+" : ""}${formatChips(data.netResult)} Chips).`;
  } catch (error) {
    await launch;
    pinballBall.setAttribute("cx", 300);
    pinballBall.setAttribute("cy", 20);
    pinballMessage.textContent = error.message;
    // A timed-out request may already have been settled: never replay it.
    try {
      const current = await api("/api/auth/me", {signal: AbortSignal.timeout(8000)});
      if (state.token === token && Number.isFinite(current.game?.balance)) {
        state.balance = current.game.balance;
        pinballSelectedBet = 0;
        ui.balance.textContent = formatChips(state.balance);
      }
    } catch { /* The next session refresh reconciles the balance. */ }
  }
  finally { state.busy = false; updatePinballControls(); updateControls(); }
});
updatePinballControls();
