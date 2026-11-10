const adminSupportUi = {
  panel: document.querySelector("#admin-support-panel"),
  badge: document.querySelector("#admin-ticket-badge"),
  notice: document.querySelector("#admin-support-notice"),
  list: document.querySelector("#admin-ticket-list"),
  empty: document.querySelector("#admin-ticket-empty")
};
let adminSupportTimer = null;
document.querySelector("#admin-support-refresh").addEventListener("click", () => loadAdminSupport());

function adminTicketCard(ticket) {
  const article = document.createElement("article");
  article.className = "admin-ticket";
  const heading = document.createElement("div");
  heading.className = "admin-ticket-heading";
  const title = document.createElement("h3");
  title.textContent = ticket.title;
  const meta = document.createElement("span");
  meta.textContent = `${ticket.username} · ${formatDate(ticket.created_at)}`;
  heading.append(title, meta);
  const body = document.createElement("p");
  body.textContent = ticket.body;
  article.append(heading, body);
  if (ticket.reply) {
    const reply = document.createElement("div");
    reply.className = "admin-ticket-reply";
    const label = document.createElement("strong");
    label.textContent = `Beantwortet · ${formatDate(ticket.replied_at)}`;
    const text = document.createElement("p");
    text.textContent = ticket.reply;
    reply.append(label, text);
    article.append(reply);
  } else {
    const form = document.createElement("form");
    form.className = "admin-ticket-form";
    const label = document.createElement("label");
    label.textContent = "Antwort";
    const input = document.createElement("textarea");
    input.required = true;
    input.maxLength = 5000;
    label.append(input);
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "admin-primary";
    button.textContent = "Antwort senden";
    form.append(label, button);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      button.disabled = true;
      try {
        await request(`/api/admin/support/${ticket.id}/reply`, { method: "POST", body: JSON.stringify({ reply: input.value.trim() }) });
        adminSupportUi.notice.textContent = "Antwort gesendet.";
        await loadAdminSupport();
      } catch (error) {
        adminSupportUi.notice.textContent = error.message;
        button.disabled = false;
      }
    });
    article.append(form);
  }
  return article;
}

async function loadAdminSupport() {
  try {
    const data = await request("/api/admin/support");
    adminSupportUi.badge.hidden = data.openCount === 0;
    adminSupportUi.badge.textContent = data.openCount ? `${data.openCount}+` : "";
    adminSupportUi.list.replaceChildren(...data.tickets.map(adminTicketCard));
    adminSupportUi.empty.hidden = data.tickets.length > 0;
  } catch (error) {
    adminSupportUi.notice.textContent = error.message;
  }
}

function startAdminSupport() {
  adminSupportUi.panel.hidden = false;
  loadAdminSupport();
  if (adminSupportTimer) clearInterval(adminSupportTimer);
  adminSupportTimer = setInterval(() => {
    const draftOpen = [...adminSupportUi.list.querySelectorAll("textarea")].some(input => input.value.trim());
    if (!document.hidden && !draftOpen) loadAdminSupport();
  }, 30_000);
}
