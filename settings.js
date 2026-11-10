const settingsUi = {
  privacyOptions: document.querySelector("#privacy-options"),
  privacyUntil: document.querySelector("#privacy-until"),
  privacyMessage: document.querySelector("#privacy-message"),
  themeOptions: document.querySelector("#theme-options"),
  themeMessage: document.querySelector("#theme-message"),
  usernameForm: document.querySelector("#username-form"),
  usernameMessage: document.querySelector("#username-message"),
  passwordForm: document.querySelector("#password-form"),
  passwordMessage: document.querySelector("#password-message")
};

function settingsMessage(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle("is-success", success);
}

function renderSettings(data) {
  settingsUi.usernameForm.elements.username.value = data.username;
  settingsUi.privacyOptions.querySelectorAll("button").forEach(button => {
    const selected = Number(button.dataset.hours) === data.anonymousHours;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  settingsUi.privacyUntil.textContent = data.anonymousUntil
    ? `Anonym bis ${formatDate(data.anonymousUntil)}`
    : "Deine Big Wins zeigen deinen Benutzernamen.";
  settingsUi.themeOptions.querySelectorAll("button").forEach(button => {
    const selected = button.dataset.theme === data.theme;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    document.documentElement.dataset.theme = data.theme;
    state.user.theme = data.theme;
    renderSettings(data);
    settingsMessage(settingsUi.privacyMessage, "");
    settingsMessage(settingsUi.themeMessage, "");
  } catch (error) {
    settingsMessage(settingsUi.privacyMessage, error.message);
  }
}

settingsUi.privacyOptions.addEventListener("click", async event => {
  const button = event.target.closest("button[data-hours]");
  if (!button || button.disabled) return;
  settingsUi.privacyOptions.querySelectorAll("button").forEach(item => { item.disabled = true; });
  try {
    const data = await api("/api/settings/privacy", { method: "PATCH", body: JSON.stringify({ hours: Number(button.dataset.hours) }) });
    renderSettings({ username: settingsUi.usernameForm.elements.username.value, theme: document.documentElement.dataset.theme, ...data });
    settingsMessage(settingsUi.privacyMessage, "Anonymität gespeichert.", true);
  } catch (error) {
    settingsMessage(settingsUi.privacyMessage, error.message);
  } finally {
    settingsUi.privacyOptions.querySelectorAll("button").forEach(item => { item.disabled = false; });
  }
});

settingsUi.themeOptions.addEventListener("click", async event => {
  const button = event.target.closest("button[data-theme]");
  if (!button || button.disabled) return;
  settingsUi.themeOptions.querySelectorAll("button").forEach(item => { item.disabled = true; });
  try {
    const data = await api("/api/settings/theme", { method: "PATCH", body: JSON.stringify({ theme: button.dataset.theme }) });
    document.documentElement.dataset.theme = data.theme;
    state.user.theme = data.theme;
    settingsUi.themeOptions.querySelectorAll("button").forEach(item => {
      const selected = item.dataset.theme === data.theme;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    settingsMessage(settingsUi.themeMessage, "Farbthema gespeichert.", true);
  } catch (error) {
    settingsMessage(settingsUi.themeMessage, error.message);
  } finally {
    settingsUi.themeOptions.querySelectorAll("button").forEach(item => { item.disabled = false; });
  }
});

settingsUi.usernameForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = settingsUi.usernameForm;
  const username = form.elements.username.value.trim();
  form.querySelector("button[type='submit']").disabled = true;
  try {
    const data = await api("/api/settings/username", { method: "PATCH", body: JSON.stringify({ username, currentPassword: form.elements.currentPassword.value }) });
    state.user.username = data.username;
    ui.headerUser.textContent = data.username;
    renderAvatar(ui.headerAvatar, state.user);
    state.leaderboardSignature = "";
    form.elements.username.value = data.username;
    form.elements.currentPassword.value = "";
    settingsMessage(settingsUi.usernameMessage, "Benutzername geändert.", true);
  } catch (error) {
    settingsMessage(settingsUi.usernameMessage, error.message);
  } finally {
    form.querySelector("button[type='submit']").disabled = false;
  }
});

settingsUi.passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = settingsUi.passwordForm;
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
    settingsMessage(settingsUi.passwordMessage, "Die neuen Passwörter stimmen nicht überein.");
    return;
  }
  form.querySelector("button[type='submit']").disabled = true;
  try {
    await api("/api/settings/password", { method: "PATCH", body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value }) });
    form.reset();
    settingsMessage(settingsUi.passwordMessage, "Passwort geändert. Andere Sitzungen wurden abgemeldet.", true);
  } catch (error) {
    settingsMessage(settingsUi.passwordMessage, error.message);
  } finally {
    form.querySelector("button[type='submit']").disabled = false;
  }
});
