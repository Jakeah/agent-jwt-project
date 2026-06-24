import { Controller } from "@hotwired/stimulus";

// The coach-mode switch on the game page. Two implementation paths share the app; the user picks
// one and we persist it in localStorage, then reload so each page load wires up exactly one path
// (the agentforce + agent_chat controllers each read this key on connect and self-gate):
//
//   • "miaw"     → Apex coach via the embedded MIAW widget (reactive Q&A, verified identity).
//   • "headless" → MCP coach via the headless Agentforce Agent API (proactive, auto-comments).
//
// No server state — the choice is a pure client preference, so a plain localStorage key (shared
// by reference with the other controllers) is enough.
const COACH_MODE_KEY = "coachMode";

export default class extends Controller {
  static targets = ["button"];

  connect() {
    this.#reflect();
  }

  // data-action: click->coach-toggle#select with data-mode="miaw" | "headless"
  select(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!mode || mode === this.#mode()) return;
    try {
      window.localStorage.setItem(COACH_MODE_KEY, mode);
    } catch {
      // localStorage blocked — fall back to a one-shot reload param so the choice still applies.
    }
    // Reload so the MIAW widget / headless panel set up cleanly from scratch in the chosen mode.
    window.location.reload();
  }

  #mode() {
    try {
      return window.localStorage.getItem(COACH_MODE_KEY) || "miaw";
    } catch {
      return "miaw";
    }
  }

  // Highlight the active button.
  #reflect() {
    const active = this.#mode();
    this.buttonTargets.forEach((btn) => {
      const isActive = btn.dataset.mode === active;
      btn.classList.toggle("bg-emerald-600", isActive);
      btn.classList.toggle("text-white", isActive);
      btn.classList.toggle("text-slate-600", !isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }
}
