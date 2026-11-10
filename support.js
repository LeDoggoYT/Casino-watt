const supportUi = {
  form: document.querySelector("#support-form"),
  message: document.querySelector("#support-message"),
  list: document.querySelector("#support-ticket-list"),
  empty: document.querySelector("#support-empty"),
  badge: document.querySelector("#support-badge"),
  adminBadge: document.querySelector("#admin-support-badge")
};
let supportTimer = null;

function setSupportBadge(element, count) {
  element.hidden = count < 1;
  element.textContent = count > 0 ? `${count}+` : "";
}

async function refreshSupportBadges() {
  if (!state.token) return;
  try {
    const result = await api("/api/support/unread");
    setSupportBadge(supportUi.badge, result.count);
    if (state.adminOwner) {
      const admin = await api("/api/admin/support/unread");
      setSupportBadge(supportUi.adminBadge, admin.count);
    }
  } catch { /* Die Ticketliste zeigt Fehler beim Öffnen an. */ }
}

function startSupportPolling() {
  stopSupportPolling();
  refreshSupportBadges();
  supportTimer = setInterval(() => { if (!document.hidden) refreshSupportBadges(); }, 30_000);
}

function stopSupportPolling() {
  if (supportTimer) clearInterval(supportTimer);
  supportTimer = null;
  setSupportBadge(supportUi.badge, 0);
  setSupportBadge(supportUi.adminBadge, 0);
}

function supportTicketCard(ticket) {
  const article = document.createElement("article");
  article.className = "support-ticket";
  const heading = document.createElement("div");
  heading.className = "support-ticket-heading";
  const title = document.createElement("h3");
  title.textContent = ticket.title;
  const date = document.createElement("time");
  date.textContent = formatDate(ticket.created_at);
  heading.append(title, date);
  const body = document.createElement("p");
  body.textContent = ticket.body;
  article.append(heading, body);
  if (ticket.reply) {
    const reply = document.createElement("div");
    reply.className = "support-reply";
    const label = document.createElement("strong");
    label.textContent = `Antwort · ${formatDate(ticket.replied_at)}`;
    const text = document.createElement("p");
    text.textContent = ticket.reply;
    reply.append(label, text);
    article.append(reply);
  } else {
    const status = document.createElement("small");
    status.textContent = "Wartet auf Antwort";
    article.append(status);
  }
  return article;
}

async function loadSupportTickets() {
  supportUi.list.textContent = "Tickets werden geladen …";
  try {
    const result = await api("/api/support/tickets");
    supportUi.list.replaceChildren(...result.tickets.map(supportTicketCard));
    supportUi.empty.hidden = result.tickets.length > 0;
    setSupportBadge(supportUi.badge, 0);
    refreshSupportBadges();
  } catch (error) {
    supportUi.list.textContent = error.message;
  }
}

supportUi.form.addEventListener("submit", async event => {
  event.preventDefault();
  const form = supportUi.form;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  supportUi.message.textContent = "";
  try {
    await api("/api/support/tickets", { method: "POST", body: JSON.stringify({ title: form.elements.title.value.trim(), message: form.elements.message.value.trim() }) });
    form.reset();
    supportUi.message.textContent = "Ticket gesendet. Du siehst die Antwort hier im Support.";
    supportUi.message.classList.add("is-success");
    await loadSupportTickets();
  } catch (error) {
    supportUi.message.textContent = error.message;
    supportUi.message.classList.remove("is-success");
  } finally {
    button.disabled = false;
  }
});
