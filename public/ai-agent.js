/* Admin-only AI assistant UI.
   The server also enforces admin access; this file only controls visibility. */
(function () {
  "use strict";

  const ON_PAGE = window.location.pathname === "/ai-agent";
  let session = null;
  let suggestions = [];
  let busy = false;

  function isAdmin() {
    return Boolean(session && session.user && session.user.role === "admin");
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(message) {
    const box = document.getElementById("ai-error");
    if (!box) return;
    box.textContent = message || "";
    box.hidden = !message;
  }

  function addMessage(role, text) {
    const container = document.getElementById("ai-messages");
    if (!container) return;
    const wrapper = element("div", `ai-message ai-message-${role}`);
    wrapper.append(element("p", "ai-message-label", role === "user" ? "You" : "Assistant"));
    const body = element("p", "ai-message-text", text);
    body.style.whiteSpace = "pre-wrap";
    wrapper.append(body);
    container.append(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  function renderSuggestions(items) {
    const container = document.getElementById("ai-suggestions");
    if (!container) return;
    container.replaceChildren();
    for (const text of items || []) {
      const button = element("button", "ai-suggestion", text);
      button.type = "button";
      button.addEventListener("click", () => {
        const input = document.getElementById("ai-question");
        if (input) {
          input.value = text;
          input.focus();
        }
      });
      container.append(button);
    }
  }

  async function loadStatus() {
    const response = await window.SessionUI.request("/api/ai/status");
    if (!response.ok) return;
    const data = await response.json();
    suggestions = data.suggestions || [];
    renderSuggestions(suggestions);
    const welcome = document.getElementById("ai-welcome");
    if (welcome) {
      welcome.textContent =
        "Administrator access confirmed. I can read the live catalogue, customer register, accounts, orders, sales and security events. Ask me a question, or choose an example below.";
    }
  }

  async function ask(question) {
    if (busy) return;
    busy = true;
    showError("");
    const button = document.getElementById("ai-send");
    if (button) button.disabled = true;
    addMessage("user", question);
    try {
      const response = await window.SessionUI.request("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.error || "The assistant could not answer that question.");
        addMessage("assistant", "Sorry — I could not answer that question.");
        return;
      }
      addMessage("assistant", data.answer || "No answer was returned.");
      if (data.suggestions) renderSuggestions(data.suggestions);
    } catch (error) {
      showError("Network error. Please try again.");
    } finally {
      busy = false;
      if (button) button.disabled = false;
      const input = document.getElementById("ai-question");
      if (input) {
        input.value = "";
        input.focus();
      }
    }
  }

  function wirePage() {
    const form = document.getElementById("ai-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = document.getElementById("ai-question");
        const question = input ? input.value.trim() : "";
        if (question) ask(question);
      });
    }
    const clear = document.getElementById("ai-clear");
    if (clear) {
      clear.addEventListener("click", () => {
        const container = document.getElementById("ai-messages");
        if (!container) return;
        for (const node of [...container.children].slice(1)) node.remove();
        showError("");
      });
    }
    loadStatus().catch(() => {
      const welcome = document.getElementById("ai-welcome");
      if (welcome) welcome.textContent = "Ask me about the catalogue, customers, accounts, orders, sales or security events.";
    });
  }

  function addLauncher() {
    if (document.getElementById("ai-launcher")) return;
    const launcher = element("button", "ai-launcher", "AI");
    launcher.id = "ai-launcher";
    launcher.type = "button";
    launcher.title = "Open the admin AI assistant";
    launcher.setAttribute("aria-label", "Open the admin AI assistant");
    launcher.addEventListener("click", () => {
      window.location.assign("/ai-agent");
    });
    document.body.append(launcher);
  }

  window.SessionUI.ready()
    .then((value) => {
      session = value;
      if (!isAdmin()) return; // Viewers never see a launcher, link or chat UI.
      if (ON_PAGE) wirePage();
      else addLauncher();
    })
    .catch(() => {
      /* SessionUI redirects unauthenticated visitors to /login. */
    });
})();
