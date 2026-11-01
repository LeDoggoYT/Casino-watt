"use strict";
ui.views.market = document.querySelector("#market-view");
const marketUI = Object.fromEntries(["balance", "clock", "message", "inventory", "listings", "prices"].map(id => [id, document.querySelector(`#market-${id}`)]));
let marketData = null, marketLoading = false, marketBusy = false, marketOwner = null, marketClockOffset = 0;
function marketButton(label, handler) {
  const button = lootNode("button", "game-tile-button", label);
  button.type = "button"; button.disabled = marketBusy || state.busy;
  button.addEventListener("click", handler); return button;
}
function marketCard(item) {
  const card = styleLootItem(lootNode("article", "loot-inventory-card market-card"), item);
  card.append(lootImage(item), lootNode("strong", "", item.name)); return card;
}
function renderMarket() {
  if (!marketData) return;
  marketUI.balance.textContent = formatChips(marketData.balance);
  for (const key of ["inventory", "listings", "prices"]) marketUI[key].replaceChildren();
  for (const entry of marketData.inventory) {
    const item = marketData.items.find(i => i.key === entry.item_key);
    if (!item) continue;
    const quote = marketData.prices.find(p => p.item_key === item.key);
    const card = marketCard(item);
    card.append(lootNode("span", "loot-hint", `${entry.available} verfügbar · ${entry.quantity - entry.available} im Angebot`));
    if (entry.available) {
      card.append(marketButton(`Sofort verkaufen · ${formatChips(quote.price)} Chips`, () => marketAction("quick-sell", {itemKey: item.key, quoteBucket: quote.bucket})));
      const form = lootNode("form", "market-offer-form");
      const label = lootNode("label", "loot-hint", "Dein Angebotspreis in Chips");
      const input = lootNode("input", "market-price-input");
      input.type = "number"; input.min = ".5"; input.max = "10000000"; input.step = ".5"; input.required = true; input.value = quote.price;
      input.disabled = marketBusy || state.busy;
      label.append(input);
      const submit = marketButton("Zum Verkauf anbieten", () => {}); submit.type = "submit";
      form.append(label, submit);
      form.addEventListener("submit", event => { event.preventDefault(); if (form.reportValidity()) marketAction("list", {itemKey: item.key, price: Number(input.value)}); });
      card.append(form);
    }
    marketUI.inventory.append(card);
  }
  if (!marketData.inventory.length) marketUI.inventory.append(lootNode("p", "loot-hint", "Noch keine Gegenstände. Öffne eine Lootbox oder kaufe ein Spielerangebot."));
  for (const listing of marketData.listings) {
    const item = marketData.items.find(i => i.key === listing.item_key);
    if (!item) continue;
    const card = marketCard(item);
    card.append(lootNode("span", "loot-hint", listing.mine ? "Dein Angebot" : `Verkäufer: ${listing.username}`), lootNode("strong", "", `${formatChips(listing.price)} Chips`));
    const button = marketButton(listing.mine ? "Angebot zurücknehmen" : "Kaufen", () => marketAction(listing.mine ? "cancel" : "buy", {listingId: listing.id}));
    if (!listing.mine && listing.price > marketData.balance) { button.disabled = true; button.textContent = "Nicht genügend Chips"; }
    card.append(button); marketUI.listings.append(card);
  }
  if (!marketData.listings.length) marketUI.listings.append(lootNode("p", "loot-hint", "Noch keine Angebote. Stelle den ersten Gegenstand ein."));
  for (const quote of marketData.prices) {
    const item = marketData.items.find(i => i.key === quote.item_key);
    const card = marketCard(item);
    card.append(lootNode("strong", "", `${formatChips(quote.price)} Chips`), lootNode("span", quote.change < 0 ? "loot-loss" : "loot-profit", `${quote.change > 0 ? "+" : ""}${quote.change} % · letztes Intervall`), lootNode("span", "loot-hint", `${quote.supply} im Umlauf bei Preisberechnung`));
    marketUI.prices.append(card);
  }
}
function acceptMarket(data) {
  marketData = data; marketClockOffset = data.serverTime * 1000 - Date.now();
  state.balance = data.balance; ui.balance.textContent = formatChips(data.balance); renderMarket();
}
async function loadMarket() {
  if (marketLoading || marketBusy || state.busy || !state.token) return;
  const token = state.token;
  if (marketOwner !== token) {
    marketOwner = token; marketData = null;
    for (const key of ["inventory", "listings", "prices"]) marketUI[key].replaceChildren();
    marketUI.message.textContent = "Handelsplatz wird geladen …";
  }
  marketLoading = true;
  try {
    const data = await api("/api/market/current", {signal: AbortSignal.timeout(8000)});
    if (state.token !== token || state.activeView !== "market" || state.busy) return;
    // Avoid erasing an offer price while the user is typing.
    marketData = data; marketClockOffset = data.serverTime * 1000 - Date.now();
    if (!document.activeElement?.closest(".market-offer-form")) acceptMarket(data);
    marketUI.message.textContent = "Handel mit Spielchips · keine Gebühren";
  } catch (error) { if (state.token === token) marketUI.message.textContent = error.message; }
  finally { marketLoading = false; }
}
async function marketAction(action, payload) {
  if (marketBusy || state.busy || marketLoading) return;
  const token = state.token;
  marketBusy = true; state.busy = true; renderMarket();
  try {
    const data = await api(`/api/market/${action}`, {method: "POST", signal: AbortSignal.timeout(8000), body: JSON.stringify({...payload, actionId: actionId()})});
    if (state.token !== token) return;
    acceptMarket(data);
    marketUI.message.textContent = ({list: "Dein Angebot ist online.", buy: "Gekauft! Der Gegenstand ist jetzt in deinem Inventar.", cancel: "Angebot zurückgenommen.", "quick-sell": "Verkauft! Die Chips wurden gutgeschrieben."})[action];
  } catch (error) {
    if (state.token !== token) return;
    marketUI.message.textContent = `${error.message} Bestand wird neu geprüft.`;
    try { const data = await api("/api/market/current", {signal: AbortSignal.timeout(8000)}); if (state.token === token) acceptMarket(data); } catch {}
  } finally { marketBusy = false; state.busy = false; if (state.token === token) renderMarket(); updateControls(); }
}
setInterval(() => {
  if (!state.token || state.activeView !== "market" || document.hidden) return;
  if (marketData) {
    const remaining = Math.max(0, Math.ceil(marketData.nextUpdate - (Date.now()+marketClockOffset)/1000));
    marketUI.clock.textContent = `Nächster Preiswechsel: ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,"0")}`;
  }
}, 1000);
setInterval(() => { if (state.activeView === "market" && !document.hidden) loadMarket(); }, 10000);
