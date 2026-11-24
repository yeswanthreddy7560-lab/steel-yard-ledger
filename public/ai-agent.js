/* Admin-only AI assistant UI.
   The server also enforces admin access; this file only controls visibility. */
(function () {
  "use strict";

  const ON_PAGE = window.location.pathname === "/ai-agent";
  let session = null;
  let suggestions = [];
  let agents = [];
  let selectedAgent = "";
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

  function card(title, lines) {
    const node = element("section", "ai-card");
    node.append(element("p", "ai-card-title", title));
    for (const line of lines) node.append(element("p", "ai-card-body", line));
    return node;
  }

  function renderConfirmation(data) {
    const container = document.getElementById("ai-messages");
    if (!container || !data.confirmation) return;
    const confirmation = data.confirmation;
    const node = card(`Proposed change · ${confirmation.label}`, [confirmation.preview]);
    const button = element("button", "ai-card-button", "Approve & apply");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      showError("");
      try {
        const response = await window.SessionUI.request("/api/ai/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: confirmation.action,
            params: data.proposal.params,
            confirmToken: confirmation.confirmToken
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          showError(result.error || "The change could not be applied.");
          return;
        }
        addMessage("assistant", result.result || "Change applied.", data.agentName);
        node.remove();
      } catch (error) {
        showError("Network error. The change was not applied.");
      } finally {
        button.disabled = false;
      }
    });
    node.append(button);
    container.append(node);
    container.scrollTop = container.scrollHeight;
  }

  function renderCodeProposal(proposal) {
    const container = document.getElementById("ai-messages");
    if (!container || !proposal) return;
    const node = card(`Code proposal · ${proposal.title}`, proposal.steps.map((step) => `• ${step}`));
    const button = element("button", "ai-card-button", "Copy steps");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(proposal.steps.join("\n"));
        button.textContent = "Copied";
      } catch (error) {
        button.textContent = "Copy failed";
      }
    });
    node.append(button);
    container.append(node);
    container.scrollTop = container.scrollHeight;
  }

  function showError(message) {
    const box = document.getElementById("ai-error");
    if (!box) return;
    box.textContent = message || "";
    box.hidden = !message;
  }

  function addMessage(role, text, meta) {
    const container = document.getElementById("ai-messages");
    if (!container) return;
    const wrapper = element("div", `ai-message ai-message-${role}`);
    const label = role === "user" ? "You" : "Assistant" + (meta ? ` · ${meta}` : "");
    wrapper.append(element("p", "ai-message-label", label));
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

  function renderAgents(items) {
    const container = document.getElementById("ai-agents");
    if (!container) return;
    container.replaceChildren();
    container.append(element("span", "ai-agents-label", "Agent:"));

    const auto = element("button", "ai-agent-chip", "Auto");
    auto.type = "button";
    auto.title = "Route each question to the best agent";
    auto.addEventListener("click", () => {
      selectedAgent = "";
      highlightAgents();
    });
    auto.dataset.agent = "";
    container.append(auto);

    for (const item of items || []) {
      const chip = element("button", "ai-agent-chip", item.name);
      chip.type = "button";
      chip.title = item.description;
      chip.dataset.agent = item.id;
      chip.addEventListener("click", () => {
        selectedAgent = item.id;
        highlightAgents();
      });
      container.append(chip);
    }
    highlightAgents();
  }

  function highlightAgents() {
    const container = document.getElementById("ai-agents");
    if (!container) return;
    for (const chip of container.querySelectorAll(".ai-agent-chip")) {
      chip.classList.toggle("is-active", chip.dataset.agent === selectedAgent);
      chip.setAttribute("aria-pressed", chip.dataset.agent === selectedAgent ? "true" : "false");
    }
    const input = document.getElementById("ai-question");
    if (input) input.placeholder = selectedAgent
      ? `Ask the ${selectedAgent} agent…`
      : "Ask about stock, customers, pending approvals…";
  }

  async function loadStatus() {
    const response = await window.SessionUI.request("/api/ai/status");
    if (!response.ok) return;
    const data = await response.json();
    suggestions = data.suggestions || [];
    agents = data.agents || [];
    renderSuggestions(suggestions);
    renderAgents(agents);
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
        body: JSON.stringify({ question, agentId: selectedAgent })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.error || "The assistant could not answer that question.");
        addMessage("assistant", "Sorry — I could not answer that question.");
        return;
      }
      addMessage("assistant", data.answer || "No answer was returned.", data.agentName);
      if (data.confirmationError) showError(data.confirmationError);
      if (data.confirmation) renderConfirmation(data);
      if (data.codeProposal) renderCodeProposal(data.codeProposal);
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
