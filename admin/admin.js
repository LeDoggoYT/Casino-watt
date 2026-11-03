"use strict";

// Muss immer identisch mit der API_URL in ../script.js sein.
const API_URL = "https://ledoggo.pythonanywhere.com";
const TOKEN_KEY = "wattCasinoSessionToken";
const PERMISSION_LABELS = {
  view_players: "Spieler ansehen",
  change_balance: "Guthaben ändern",
  rename_players: "Benutzernamen ändern",
  suspend_players: "Spieler sperren/entsperren"
};

const ui = {
  login: document.querySelector("#admin-login"),
  loginMessage: document.querySelector("#admin-login-message"),
  app: document.querySelector("#admin-app"),
  moderatorPanel: document.querySelector("#moderator-panel"),
  moderatorForm: document.querySelector("#moderator-form"),
  moderatorPermissions: document.querySelector("#moderator-permissions"),
  moderatorList: document.querySelector("#moderator-list"),
  moderatorNotice: document.querySelector("#moderator-notice"),
  searchForm: document.querySelector("#admin-search-form"),
  search: document.querySelector("#admin-search"),
  notice: document.querySelector("#admin-notice"),
  list: document.querySelector("#admin-player-list"),
  empty: document.querySelector("#admin-empty"),
  prev: document.querySelector("#admin-prev"),
  next: document.querySelector("#admin-next"),
  pageLabel: document.querySelector("#admin-page-label")
};

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  access: null,
  page: 1,
  totalPages: 1,
  search: "",
  loading: false
};

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error("Die API ist derzeit nicht erreichbar.");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    if (response.status === 401 || response.status === 403 && path === "/api/admin/me") showLogin();
    throw new Error(payload?.message || "Die Anfrage konnte nicht verarbeitet werden.");
  }
  return payload.data;
}

function showLogin() {
  ui.app.hidden = true;
  ui.login.hidden = false;
}

async function showApp() {
  try {
    state.access = await request("/api/admin/me");
  } catch (error) {
    ui.loginMessage.textContent = error.message;
    showLogin();
    return;
  }
  ui.login.hidden = true;
  ui.app.hidden = false;
  loadPlayers();
  if (state.access.role === "owner") {
    ui.moderatorPanel.hidden = false;
    loadModerators();
  }
}

function setNotice(message = "", error = false) {
  ui.notice.textContent = message;
  ui.notice.classList.toggle("is-error", error);
}

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function formatChips(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("de-CH", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "–";
}

function playerCard(player) {
  const article = document.createElement("article");
  article.className = `admin-player${player.suspended ? " is-suspended" : ""}`;
  article.dataset.playerId = player.id;
  article.innerHTML = `
    <div class="admin-player-identity">
      <h2>${escapeHtml(player.username)}</h2>
      <p><strong>${formatChips(player.balance)} Chips</strong><br>${player.roundsPlayed} Runden · ${player.wins} Siege · ${player.losses} Niederlagen<br>Zuletzt aktiv: ${formatDate(player.lastActivityAt)}</p>
      ${player.suspended ? `<span class="admin-badge">Gesperrt</span>` : player.hasActiveRound ? `<span class="admin-badge is-active">Runde läuft</span>` : ""}
    </div>
    ${state.access.permissions.includes("rename_players") ? `<div class="admin-field">
      <label>Benutzername</label>
      <div class="admin-field-row"><input class="username-input" maxlength="20" value="${escapeHtml(player.username)}"><button class="admin-action username-save" type="button">Ändern</button></div>
    </div>` : ""}
    ${state.access.permissions.includes("change_balance") ? `<div class="admin-field">
      <label>Guthaben</label>
      <div class="admin-field-row"><input class="balance-input" type="number" min="0" max="1000000000" step="0.5" value="${player.balance}"><button class="admin-action balance-save" type="button" ${player.hasActiveRound ? "disabled" : ""}>Setzen</button></div>
    </div>` : ""}
    ${state.access.permissions.includes("suspend_players") ? `<div class="admin-field">
      <label>${player.suspended ? "Sperrgrund" : "Begründung für Sperre"}</label>
      <textarea class="suspension-reason" maxlength="300" placeholder="Grund für die Sperre">${escapeHtml(player.suspensionReason || "")}</textarea>
      <div class="admin-suspension-actions">
        ${player.suspended
          ? `<button class="admin-action admin-action--release suspension-toggle" data-suspended="false" type="button">Sperre aufheben</button>`
          : `<button class="admin-action admin-action--danger suspension-toggle" data-suspended="true" type="button">Spieler sperren</button>`}
      </div>
    </div>` : ""}`;

  article.querySelector(".username-save")?.addEventListener("click", () => updateUsername(player.id, article));
  article.querySelector(".balance-save")?.addEventListener("click", () => updateBalance(player.id, article));
  article.querySelector(".suspension-toggle")?.addEventListener("click", (event) => updateSuspension(player.id, article, event.currentTarget.dataset.suspended === "true"));
  return article;
}

async function loadPlayers() {
  if (!state.token || state.loading) return;
  state.loading = true;
  setNotice("Spielerliste wird geladen …");
  try {
    const data = await request(`/api/admin/players?page=${state.page}&search=${encodeURIComponent(state.search)}`);
    state.page = data.pagination.page;
    state.totalPages = data.pagination.totalPages;
    ui.list.replaceChildren(...data.players.map(playerCard));
    ui.empty.hidden = data.players.length > 0;
    ui.pageLabel.textContent = `Seite ${state.page} von ${state.totalPages}`;
    ui.prev.disabled = state.page <= 1;
    ui.next.disabled = state.page >= state.totalPages;
    setNotice();
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    state.loading = false;
  }
}

async function mutate(path, body, successMessage) {
  setNotice("Änderung wird gespeichert …");
  try {
    await request(path, { method: "PATCH", body: JSON.stringify(body) });
    setNotice(successMessage);
    await loadPlayers();
  } catch (error) {
    setNotice(error.message, true);
  }
}

function updateUsername(id, article) {
  const username = article.querySelector(".username-input").value.trim();
  mutate(`/api/admin/players/${id}/username`, { username }, "Benutzername aktualisiert.");
}

function updateBalance(id, article) {
  const amount = Number(article.querySelector(".balance-input").value);
  mutate(`/api/admin/players/${id}/balance`, { amount }, "Guthaben aktualisiert.");
}

function updateSuspension(id, article, suspended) {
  const reason = article.querySelector(".suspension-reason").value.trim();
  mutate(`/api/admin/players/${id}/suspension`, { suspended, reason }, suspended ? "Spieler gesperrt." : "Sperre aufgehoben.");
}

async function loadModerators() {
  try {
    const data = await request("/api/admin/moderators");
    ui.moderatorPermissions.replaceChildren(...data.availablePermissions.map((key) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" name="permissions" value="${key}" ${key === "view_players" ? "checked" : ""}> ${PERMISSION_LABELS[key]}`;
      return label;
    }));
    ui.moderatorList.replaceChildren(...data.moderators.map((moderator) => {
      const row = document.createElement("div");
      row.className = "moderator-row";
      row.innerHTML = `<strong>${escapeHtml(moderator.username)}</strong><span>${moderator.permissions.map((key) => PERMISSION_LABELS[key]).join(" · ")}</span><button class="admin-action moderator-edit" type="button">Bearbeiten</button><button class="admin-action admin-action--danger moderator-remove" type="button">Entfernen</button>`;
      row.querySelector(".moderator-edit").addEventListener("click", () => {
        ui.moderatorForm.elements.username.value = moderator.username;
        ui.moderatorPermissions.querySelectorAll("input").forEach((input) => { input.checked = moderator.permissions.includes(input.value); });
        ui.moderatorForm.scrollIntoView({ behavior: "smooth" });
      });
      row.querySelector(".moderator-remove").addEventListener("click", async () => {
        try {
          await request(`/api/admin/moderators/${encodeURIComponent(moderator.username)}`, { method: "DELETE" });
          ui.moderatorNotice.textContent = "Moderator entfernt.";
          await loadModerators();
        } catch (error) { ui.moderatorNotice.textContent = error.message; }
      });
      return row;
    }));
  } catch (error) { ui.moderatorNotice.textContent = error.message; }
}

ui.moderatorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = ui.moderatorForm.elements.username.value.trim();
  const permissions = [...ui.moderatorPermissions.querySelectorAll("input:checked")].map((input) => input.value);
  try {
    await request(`/api/admin/moderators/${encodeURIComponent(username)}`, { method: "PUT", body: JSON.stringify({ permissions }) });
    ui.moderatorNotice.textContent = "Moderatorrechte gespeichert.";
    ui.moderatorForm.reset();
    await loadModerators();
  } catch (error) { ui.moderatorNotice.textContent = error.message; }
});
ui.searchForm.addEventListener("submit", (event) => { event.preventDefault(); state.search = ui.search.value.trim(); state.page = 1; loadPlayers(); });
ui.prev.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; loadPlayers(); } });
ui.next.addEventListener("click", () => { if (state.page < state.totalPages) { state.page += 1; loadPlayers(); } });

if (state.token) showApp();
else ui.loginMessage.textContent = "Bitte zuerst im Casino anmelden.";
