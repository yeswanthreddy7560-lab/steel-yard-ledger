/* Dark/light theme system for Steel Yard Ledger.
 *
 * - System preference is the default; `[data-theme]` on <html> overrides it
 *   (light/dark). CSS also handles the no-JS system default via
 *   `@media (prefers-color-scheme: dark)` and `html[data-theme="dark"]`.
 * - Choice persists in localStorage under "steelYardTheme".
 * - Wires the #theme-toggle button present on every page (session bars and
 *   auth pages).
 */
(function () {
  "use strict";

  var root = document.documentElement;

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function effectiveTheme() {
    var saved = root.dataset.theme;
    if (saved === "light" || saved === "dark") return saved;
    return systemPrefersDark() ? "dark" : "light";
  }

  function updateToggle(theme) {
    var toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    var dark = theme === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute(
      "aria-label",
      dark ? "Switch to light mode" : "Switch to dark mode"
    );
    toggle.querySelectorAll(".theme-icon").forEach(function (icon) {
      icon.hidden = (icon.dataset.theme === "dark") === dark;
    });
    var label = toggle.querySelector("span");
    if (label) label.textContent = dark ? "Light mode" : "Dark mode";
  }

  function applyTheme(theme) {
    if (theme === "dark") root.dataset.theme = "dark";
    else if (theme === "light") root.dataset.theme = "light";
    else root.dataset.theme = "";
    updateToggle(effectiveTheme());
    try {
      localStorage.setItem("steelYardTheme", theme);
    } catch (error) {
      /* storage unavailable: system default still applies */
    }
  }

  function restore() {
    var saved;
    try {
      saved = localStorage.getItem("steelYardTheme");
    } catch (error) {
      saved = null;
    }
    if (saved === "light" || saved === "dark") applyTheme(saved);
    else updateToggle(effectiveTheme());
  }

  function wireToggle() {
    var toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      applyTheme(effectiveTheme() === "dark" ? "light" : "dark");
    });
  }

  restore();
  wireToggle();
})();
