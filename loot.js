"use strict";
ui.views.loot = document.querySelector("#loot-view");
const lootUI = Object.fromEntries(["balance", "boxes", "stage-name", "reel", "track", "result", "open", "message", "rewards", "history", "inventory"].map(id => [id, document.querySelector(`#loot-${id}`)]));
let lootCatalog = null;
let lootSelected = "tech";
let lootLoading = false;
let lootOpening = false;
let lootOwner = null;
function lootNode(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function updateLootControls() {
  const box = lootCatalog?.boxes.find(item => item.key === lootSelected);
  lootUI.balance.textContent = formatChips(state.balance);
  lootUI.open.disabled = state.busy || lootOpening || lootLoading || !box || state.balance < box.price;
  lootUI.open.textContent = lootOpening ? "Wird geöffnet …" : !box ? "Boxen laden" : state.balance < box.price ? "Nicht genügend Chips" : `Für ${formatChips(box.price)} Chips öffnen`;
  lootUI.boxes.querySelectorAll("button").forEach(button => {
    button.disabled = lootOpening || state.busy || lootLoading;
    button.setAttribute("aria-pressed", String(button.dataset.box === lootSelected));
  });
}
function lootReelPosition(index) {
  return `translateX(calc(-${index} * (var(--loot-card-width) + 12px) - var(--loot-card-width) / 2))`;
}
function lootRewards(box) { return box.rewards; }
const lootMoney = value => new Intl.NumberFormat("de-CH", {style: "currency", currency: "CHF"}).format(value);
function styleLootItem(node, item) {
  node.style.setProperty("--loot-accent", item.color);
  node.style.setProperty("--loot-tint", `color-mix(in srgb, ${item.color} 24%, #131c18)`);
  return node;
}
function lootPriceLink(item) {
  const link = lootNode("a", "loot-reference-price", `Referenz: ${lootMoney(item.valueChf)} ↗`);
  link.href = item.source; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.title = `Preisquelle · recherchiert ${lootCatalog.checkedAt}. ${item.priceNote ?? "Gelisteter Händlerpreis, ohne Versandkosten. Abbildung kann in Farbe und Ausstattung abweichen."}`;
  return link;
}
function lootImage(item, className = "loot-item-image") {
  const image = lootNode("img", className);
  image.src = item.image; image.alt = item.name; image.width = 160; image.height = 100;
  image.addEventListener("error", () => { image.replaceWith(lootNode("span", "loot-image-fallback", item.name)); }, {once: true});
  return image;
}
function renderLootInventory(inventory = []) {
  lootUI.inventory.replaceChildren();
  if (!inventory.length) { lootUI.inventory.append(lootNode("p", "loot-hint", "Noch keine Gegenstände. Öffne ein Technik-Pack für deinen ersten Fund.")); return; }
  for (const entry of inventory) {
    const index = lootCatalog.items.findIndex(item => item.key === entry.item_key);
    const item = lootCatalog.items[index];
    if (!item) continue;
    const card = styleLootItem(lootNode("div", `loot-inventory-card loot-rarity-${index}`), item);
    card.append(lootImage(item), lootNode("strong", "", item.name), lootPriceLink(item), lootNode("span", "loot-hint", `${entry.quantity}× gesammelt`));
    lootUI.inventory.append(card);
  }
}
function renderLootReel(box, rewardIndex = null) {
  lootUI.track.replaceChildren();
  lootUI.reel.classList.remove("is-spinning", "has-winner");
  const winnerIndex = 32;
  const count = rewardIndex === null ? 12 : winnerIndex + 6;
  const rewards = lootRewards(box);
  for (let index = 0; index < count; index++) {
    // Decorative cards follow the displayed odds; only the server selects the winner.
    let roll = Math.random() * 100;
    let chosen = rewards.length - 1;
    for (let i = 0; i < rewards.length; i++) {
      roll -= rewards[i].chance;
      if (roll < 0) { chosen = i; break; }
    }
    if (index === winnerIndex && rewardIndex !== null) chosen = rewardIndex;
    const reward = rewards[chosen];
    const card = styleLootItem(lootNode("div", `loot-reel-card loot-rarity-${chosen}`), reward);
    card.append(lootImage(reward), lootNode("strong", "loot-product-name", reward.name), lootNode("span", "loot-reel-unit", lootMoney(reward.valueChf)));
    lootUI.track.append(card);
  }
  lootUI.track.style.transform = lootReelPosition(2);
  return winnerIndex;
}
async function spinLootReel(box, rewardIndex) {
  const winnerIndex = renderLootReel(box, rewardIndex);
  await Promise.allSettled([...lootUI.track.querySelectorAll("img")].map(image => image.decode()));
  const start = lootReelPosition(2), end = lootReelPosition(winnerIndex);
  lootUI.reel.classList.add("is-spinning");
  lootUI.track.style.transform = end;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const animation = lootUI.track.animate([{transform: start}, {transform: end}], {duration: 4200, easing: "cubic-bezier(.12,.72,.12,1)"});
    await animation.finished;
  }
  lootUI.reel.classList.remove("is-spinning");
  lootUI.reel.classList.add("has-winner");
  lootUI.track.children[winnerIndex].classList.add("is-winner");
}
function renderLootSelection() {
  const box = lootCatalog.boxes.find(item => item.key === lootSelected);
  lootUI["stage-name"].textContent = `${box.name} · ${formatChips(box.price)} Chips`;
  renderLootReel(box);
  lootUI.result.textContent = "Deine nächste Überraschung wartet.";
  lootUI.rewards.replaceChildren();
  lootRewards(box).forEach((reward, index) => {
    const row = styleLootItem(lootNode("div", `loot-reward loot-rarity-${index}`), reward);
    const info = lootNode("div", "loot-reward-info");
    info.append(lootNode("strong", "loot-reward-name", reward.name), lootPriceLink(reward));
    row.append(lootImage(reward, "loot-reward-image"), info, lootNode("span", "loot-chance", `${reward.chance} %`));
    lootUI.rewards.append(row);
  });
  updateLootControls();
}
function renderLootHistory(history) {
  lootUI.history.replaceChildren();
  if (!history.length) { lootUI.history.append(lootNode("p", "loot-hint", "Du hast noch keine Box geöffnet.")); return; }
  for (const item of history) {
    const box = lootCatalog.boxes.find(box => box.key === item.box_key);
    const net = item.payout - item.price;
    const card = lootNode("div", `loot-history-item loot-rarity-${item.reward_index}`);
    const product = lootCatalog.items?.find(product => product.key === item.item_key);
    if (product) { styleLootItem(card, product); card.append(lootImage(product), lootNode("strong", "", product.name)); }
    else card.append(lootNode("span", "loot-hint", "Frühere Chips-Box · Archiv"), lootNode("strong", "", `${formatChips(item.payout)} Chips`), lootNode("span", net >= 0 ? "loot-profit" : "loot-loss", `${net >= 0 ? "+" : ""}${formatChips(net)} Chips netto`));
    lootUI.history.append(card);
  }
}
async function loadLoot() {
  if (lootOpening || lootLoading) return;
  if (lootOwner !== state.token) {
    lootCatalog = null;
    for (const key of ["history", "inventory", "boxes", "rewards", "track"]) lootUI[key].replaceChildren();
    lootUI.result.textContent = "Deine Sammlung wird geladen …";
    lootOwner = state.token;
  }
  lootLoading = true; updateLootControls();
  const token = state.token;
  try {
    const data = await api("/api/loot/current", {signal: AbortSignal.timeout(8000)});
    if (state.token !== token || state.activeView !== "loot" || state.busy) return;
    if (data.catalogVersion !== 2) throw new Error("Bitte das Backend inklusive loot_catalog.json aktualisieren und Reload klicken.");
    lootCatalog = data;
    if (!data.boxes.some(box => box.key === lootSelected)) lootSelected = data.boxes[0].key;
    state.balance = data.balance;
    ui.balance.textContent = formatChips(data.balance);
    lootUI.boxes.replaceChildren();
    for (const box of data.boxes) {
      const button = lootNode("button", "loot-box-choice"); button.type = "button"; button.dataset.box = box.key;
      const icon = lootImage({name: box.name, image: `assets/loot/preview-${box.key}.png`}, "loot-box-photo"); icon.setAttribute("aria-hidden", "true");
      button.append(icon, lootNode("strong", "", box.name), lootNode("span", "loot-box-price", `${formatChips(box.price)} Chips`));
      button.addEventListener("click", () => { if (lootOpening || state.busy) return; lootSelected = box.key; renderLootSelection(); });
      lootUI.boxes.append(button);
    }
    renderLootSelection(); renderLootHistory(data.history); renderLootInventory(data.inventory);
    lootUI.message.textContent = "";
    lootUI.message.hidden = true;
  } catch (error) { lootUI.message.textContent = error.message; lootUI.message.hidden = false; }
  finally { lootLoading = false; updateLootControls(); }
}
lootUI.open.addEventListener("click", async () => {
  const box = lootCatalog?.boxes.find(item => item.key === lootSelected);
  if (!box || lootLoading || lootOpening || state.busy || state.balance < box.price) return;
  const token = state.token;
  lootOpening = true; state.busy = true; updateLootControls();
  lootUI.reel.classList.remove("has-winner");
  lootUI.result.textContent = "Die Box wird vorbereitet …";
  lootUI.message.textContent = "";
  lootUI.message.hidden = true;
  try {
    const data = await api("/api/loot/open", {method: "POST", signal: AbortSignal.timeout(8000), body: JSON.stringify({box: box.key, actionId: actionId()})});
    if (state.token !== token) return;
    state.balance = data.balance;
    ui.balance.textContent = formatChips(data.balance);
    lootUI.result.textContent = "Der Gewinnstreifen läuft …";
    await spinLootReel(box, data.rewardIndex);
    if (state.token !== token) return;
    lootUI.result.replaceChildren(lootImage(data.item, "loot-result-image"), lootNode("strong", "", data.item.name), lootPriceLink(data.item), lootNode("span", "loot-result-label", "Neu in deinem Inventar"));
    renderLootInventory(data.inventory);
    renderLootHistory(data.history);
  } catch (error) {
    lootUI.reel.classList.remove("is-spinning");
    lootUI.result.textContent = "Öffnung nicht bestätigt.";
    lootUI.message.textContent = error.message;
    lootUI.message.hidden = false;
    // Reconcile a possibly committed opening after a network timeout.
    try {
      const data = await api("/api/loot/current", {signal: AbortSignal.timeout(8000)});
      if (state.token === token) { state.balance = data.balance; ui.balance.textContent = formatChips(data.balance); renderLootHistory(data.history); renderLootInventory(data.inventory); }
    } catch { /* The next visit reloads the persisted history. */ }
  } finally { lootOpening = false; state.busy = false; updateLootControls(); updateControls(); }
});
