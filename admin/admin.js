"use strict";

// Muss immer identisch mit der API_URL in ../script.js sein.
const API_URL = "https://ledoggo.pythonanywhere.com";
const TOKEN_KEY = "wattCasinoSessionToken";
const PERMISSION_LABELS = {
  view_players: "Spieler ansehen",
  change_balance: "Guthaben ändern",
  change_own_balance: "Nur eigenes Guthaben ändern",
  rename_players: "Benutzernamen ändern",
  suspend_players: "Spieler sperren/entsperren"
};

const ui = {
  login: document.querySelector("#admin-login"),
  loginMessage: document.querySelector("#admin-login-message"),
  app: document.querySelector("#admin-app"),
  moderatorPanel: document.querySelector("#moderator-panel"),
  moderatorForm: document.querySelector("#moderator-form"),
  moderatorSearch: document.querySelector("#moderator-search"),
  moderatorSearchResults: document.querySelector("#moderator-search-results"),
  moderatorSelected: document.querySelector("#moderator-selected"),
  moderatorSave: document.querySelector("#moderator-save"),
  moderatorPermissions: document.querySelector("#moderator-permissions"),
  moderatorList: document.querySelector("#moderator-list"),
  moderatorNotice: document.querySelector("#moderator-notice"),
  searchForm: document.querySelector("#admin-search-form"),
  search: document.querySelector("#admin-search"),
  notice: document.querySelector("#admin-notice"),
  results: document.querySelector("#admin-results"),
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
  loadRequestId: 0,
  moderatorSearchId: 0
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
  ui.searchForm.hidden = !state.access.permissions.includes("view_players");
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
  const article = document.createElement("details");
  article.className = `admin-player${player.suspended ? " is-suspended" : ""}`;
  article.dataset.playerId = player.id;
  const canChangeBalance = state.access.permissions.includes("change_balance") ||
    state.access.permissions.includes("change_own_balance") && player.id === state.access.userId;
  article.innerHTML = `<summary class="admin-player-summary">
      <span class="admin-player-name">${escapeHtml(player.username)}</span>
      <span class="admin-player-money">${formatChips(player.balance)} Chips</span>
      <span class="admin-player-status">${player.suspended ? `<span class="admin-badge">Gesperrt</span>` : player.hasActiveRound ? `<span class="admin-badge is-active">Runde läuft</span>` : "Aktiv"}</span>
      <span class="admin-player-open">Bearbeiten <span aria-hidden="true">⌄</span></span>
    </summary><div class="admin-player-actions">
    <p class="admin-player-meta">${player.roundsPlayed} Runden · ${player.wins} Siege · ${player.losses} Niederlagen · Zuletzt aktiv: ${formatDate(player.lastActivityAt)}</p>
    ${state.access.permissions.includes("rename_players") ? `<div class="admin-field">
      <label>Benutzername</label>
      <div class="admin-field-row"><input class="username-input" maxlength="20" value="${escapeHtml(player.username)}"><button class="admin-action username-save" type="button">Ändern</button></div>
    </div>` : ""}
    ${canChangeBalance ? `<div class="admin-field">
      <label>Guthaben</label>
      <div class="admin-field-row"><input class="balance-input" type="number" min="0" max="1000000000" step="0.5" value="${player.balance}"><button class="admin-action balance-save" type="button" ${player.hasActiveRound ? "disabled" : ""}>Setzen</button></div>
    </div>` : ""}
    ${state.access.permissions.includes("suspend_players") ? `<div class="admin-field">
      <label>${player.suspended ? "Sperrgrund / IP-Sperre" : "Begründung für Konto- und IP-Sperre"}</label>
      <textarea class="suspension-reason" maxlength="300" placeholder="Grund für die Sperre">${escapeHtml(player.suspensionReason || "")}</textarea>
      <small class="admin-field-help">${player.knownIpCount} bekannte IP-Adresse${player.knownIpCount === 1 ? "" : "n"}. Gemeinsame Anschlüsse können weitere Spieler betreffen.</small>
      <div class="admin-suspension-actions">
        ${player.suspended
          ? `<button class="admin-action admin-action--release suspension-toggle" data-suspended="false" type="button">Sperre aufheben</button>`
          : `<button class="admin-action admin-action--danger suspension-toggle" data-suspended="true" type="button">Spieler sperren</button>`}
      </div>
    </div>` : ""}
    ${state.access.role === "owner" ? `<div class="admin-field admin-delete-field">
      <label>Konto vollständig löschen</label>
      <p>Spielerdaten und zugehörige IP-Sperren werden entfernt.</p>
      <button class="admin-action admin-action--danger delete-start" type="button">Spieler löschen</button>
      <div class="admin-delete-confirm" hidden>
        <label>Zur Bestätigung ${escapeHtml(player.username)} eingeben</label>
        <input class="delete-username" type="text" autocomplete="off" aria-label="Benutzername zur Löschbestätigung">
        <div class="admin-suspension-actions"><button class="admin-action admin-action--danger delete-confirm-button" type="button" disabled>Endgültig löschen</button><button class="admin-action delete-cancel" type="button">Abbrechen</button></div>
      </div>
    </div>` : ""}</div>`;

  article.querySelector(".username-save")?.addEventListener("click", () => updateUsername(player.id, article));
  article.querySelector(".balance-save")?.addEventListener("click", () => updateBalance(player.id, article));
  article.querySelector(".suspension-toggle")?.addEventListener("click", (event) => updateSuspension(player.id, article, event.currentTarget.dataset.suspended === "true"));
  const deleteStart = article.querySelector(".delete-start");
  if (deleteStart) {
    const confirm = article.querySelector(".admin-delete-confirm");
    const input = article.querySelector(".delete-username");
    const button = article.querySelector(".delete-confirm-button");
    deleteStart.addEventListener("click", () => { confirm.hidden = false; deleteStart.hidden = true; input.focus(); });
    input.addEventListener("input", () => { button.disabled = input.value !== player.username; });
    article.querySelector(".delete-cancel").addEventListener("click", () => { confirm.hidden = true; deleteStart.hidden = false; input.value = ""; button.disabled = true; });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request(`/api/admin/players/${player.id}`, { method: "DELETE", body: JSON.stringify({ confirmUsername: input.value }) });
        await loadPlayers();
        setNotice("Spieler vollständig gelöscht.");
      } catch (error) { setNotice(error.message, true); button.disabled = false; }
    });
  }
  return article;
}

async function loadPlayers() {
  if (!state.token) return;
  const requestId = ++state.loadRequestId;
  setNotice("Spielerliste wird geladen …");
  try {
    const data = await request(`/api/admin/players?page=${state.page}&search=${encodeURIComponent(state.search)}`);
    if (requestId !== state.loadRequestId) return;
    state.page = data.pagination.page;
    state.totalPages = data.pagination.totalPages;
    ui.list.replaceChildren(...data.players.map(playerCard));
    ui.empty.hidden = data.players.length > 0;
    const start = data.pagination.total ? (state.page - 1) * data.pagination.limit + 1 : 0;
    const end = start + data.players.length - (start ? 1 : 0);
    ui.results.textContent = `${start}–${end} von ${data.pagination.total} Spielern`;
    ui.pageLabel.textContent = `Seite ${state.page} von ${state.totalPages}`;
    ui.prev.disabled = state.page <= 1;
    ui.next.disabled = state.page >= state.totalPages;
    setNotice();
  } catch (error) {
    if (requestId === state.loadRequestId) setNotice(error.message, true);
  }
}

async function mutate(path, body, successMessage) {
  setNotice("Änderung wird gespeichert …");
  try {
    await request(path, { method: "PATCH", body: JSON.stringify(body) });
    await loadPlayers();
    setNotice(successMessage);
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

function selectModerator(username) {
  clearTimeout(moderatorSearchTimer);
  state.moderatorSearchId += 1;
  ui.moderatorForm.elements.username.value = username;
  ui.moderatorSearch.value = username;
  ui.moderatorSelected.textContent = `Ausgewählt: ${username}`;
  ui.moderatorSelected.hidden = false;
  ui.moderatorSearchResults.hidden = true;
  ui.moderatorSave.disabled = false;
}

let moderatorSearchTimer;
ui.moderatorSearch.addEventListener("input", () => {
  const query = ui.moderatorSearch.value.trim();
  ui.moderatorForm.elements.username.value = "";
  ui.moderatorSelected.hidden = true;
  ui.moderatorSave.disabled = true;
  ui.moderatorSearchResults.hidden = true;
  clearTimeout(moderatorSearchTimer);
  const searchId = ++state.moderatorSearchId;
  if (query.length < 2) return;
  moderatorSearchTimer = setTimeout(async () => {
    try {
      const data = await request(`/api/admin/users?search=${encodeURIComponent(query)}`);
      if (searchId !== state.moderatorSearchId) return;
      ui.moderatorSearchResults.replaceChildren(...data.users.map((user) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "moderator-result";
        button.setAttribute("role", "option");
        button.innerHTML = `<strong>${escapeHtml(user.username)}</strong><span>${user.isModerator ? "Bereits Moderator" : "Spieler"}</span>`;
        button.addEventListener("click", () => selectModerator(user.username));
        return button;
      }));
      if (!data.users.length) ui.moderatorSearchResults.textContent = "Keine Spieler gefunden.";
      ui.moderatorSearchResults.hidden = false;
    } catch (error) { ui.moderatorNotice.textContent = error.message; }
  }, 250);
});

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
        selectModerator(moderator.username);
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
    ui.moderatorSelected.hidden = true;
    ui.moderatorSave.disabled = true;
    await loadModerators();
  } catch (error) { ui.moderatorNotice.textContent = error.message; }
});
ui.searchForm.addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(playerSearchTimer); state.search = ui.search.value.trim(); state.page = 1; loadPlayers(); });
let playerSearchTimer;
ui.search.addEventListener("input", () => {
  clearTimeout(playerSearchTimer);
  playerSearchTimer = setTimeout(() => { state.search = ui.search.value.trim(); state.page = 1; loadPlayers(); }, 250);
});
ui.prev.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; loadPlayers(); } });
ui.next.addEventListener("click", () => { if (state.page < state.totalPages) { state.page += 1; loadPlayers(); } });

if (state.token) showApp();
else ui.loginMessage.textContent = "Bitte zuerst im Casino anmelden.";
