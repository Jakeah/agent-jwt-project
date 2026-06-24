import { Controller } from "@hotwired/stimulus";

// Custom chat panel for the headless MCP coach (Chess_Coach_MCP via the Agentforce Agent API).
// This is the second, *proactive* coach path: it listens for `chess:turn-complete` (emitted by
// the chess controller after each player move + computer reply) and POSTs the turn to Rails, which
// composes a grounded prompt and relays the agent's reply. Also supports manual follow-up
// questions. The Salesforce session id + sequence live server-side (cached per user+game); this
// panel only ever says "here's a turn" / "here's a question" and renders what comes back.
//
// Lifecycle:
//   • connect  → wire the turn listener + render the empty transcript. The SF session is started
//                lazily on the first message (no wasted session if the user never plays).
//   • turn     → debounced send of the completed turn; "coach is thinking…" while awaiting.
//   • ask      → free-text follow-up via the input box.
//   • teardown → DELETE the session on game-over and on page unload (best-effort).
//
// Only mounted when the user has the MCP coach selected (the toggle in games/show), so it never
// fights the MIAW widget.
const SEND_DEBOUNCE_MS = 300;

export default class extends Controller {
  static values = {
    gameId: Number,
    createUrl: String,   // POST  → start/reuse session
    messageUrl: String,  // POST  → send a turn / question
    destroyUrl: String,  // DELETE → end session
  };

  connect() {
    // Self-gate on the coach mode: only the selected path runs. The toggle persists the mode in
    // localStorage and reloads, so this is read once per page load. "headless" = this MCP panel;
    // anything else (default "miaw") = the embedded widget owns the page, so we stay inert/hidden.
    if (this.#coachMode() !== "headless") {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;

    this.onTurn = this.handleTurn.bind(this);
    this.onUnload = this.teardown.bind(this);
    window.addEventListener("chess:turn-complete", this.onTurn);
    window.addEventListener("beforeunload", this.onUnload);

    this.busy = false;
    this.turnTimer = null;
    this.pendingTurn = null;
    this.started = false;

    this.#render();
  }

  #coachMode() {
    try {
      return window.localStorage.getItem("coachMode") || "miaw";
    } catch {
      return "miaw";
    }
  }

  disconnect() {
    window.removeEventListener("chess:turn-complete", this.onTurn);
    window.removeEventListener("beforeunload", this.onUnload);
    if (this.turnTimer) clearTimeout(this.turnTimer);
  }

  // --- inbound: a completed turn from the board ---
  handleTurn(event) {
    if (event.detail?.gameId !== this.gameIdValue) return;
    this.pendingTurn = event.detail;
    // Debounce so a fast sequence of moves doesn't stack agent turns (and credits).
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      const turn = this.pendingTurn;
      this.pendingTurn = null;
      if (turn) this.#sendTurn(turn);
    }, SEND_DEBOUNCE_MS);
  }

  // --- inbound: manual follow-up question (input + Enter / Send button) ---
  ask(event) {
    event?.preventDefault();
    const input = this.element.querySelector("[data-agent-chat-input]");
    const text = input?.value.trim();
    if (!text) return;
    input.value = "";
    this.#appendMessage("you", text);
    this.#post({ text });
  }

  // --- sends ---
  #sendTurn(turn) {
    const summary = this.#turnSummary(turn);
    this.#appendMessage("move", summary);
    this.#post({
      playerMove: turn.playerMove,
      computerMove: turn.computerMove,
      difficulty: turn.difficulty,
    });
  }

  async #post(payload) {
    if (this.busy) {
      // Coalesce: if a request is in flight, drop a "thinking" note rather than overlap turns.
      this.#appendMessage("system", "…(coach still thinking, skipped)");
      return;
    }
    this.busy = true;
    const thinkingEl = this.#appendMessage("coach", "Coach is thinking…", { pending: true });

    try {
      await this.#ensureSession();
      const res = await fetch(this.messageUrlValue, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        thinkingEl.textContent = data.error || `Coach unavailable (${res.status}).`;
        thinkingEl.dataset.role = "system";
        return;
      }
      thinkingEl.textContent = data.reply || "(no reply)";
      thinkingEl.removeAttribute("data-pending");
    } catch (err) {
      thinkingEl.textContent = "Couldn't reach the coach. Check your connection.";
      thinkingEl.dataset.role = "system";
    } finally {
      this.busy = false;
      this.#scrollToBottom();
    }
  }

  // Start the SF session once, lazily. The server also creates lazily on message, so this is a
  // best-effort warm-up that's safe to skip on failure.
  async #ensureSession() {
    if (this.started) return;
    this.started = true;
    try {
      await fetch(this.createUrlValue, { method: "POST", headers: this.#headers() });
    } catch {
      // ignore — message will create the session server-side anyway
    }
  }

  // --- teardown ---
  teardown() {
    if (!this.started) return;
    // Best-effort; keepalive lets it survive page unload.
    try {
      fetch(this.destroyUrlValue, {
        method: "DELETE",
        headers: this.#headers(),
        keepalive: true,
      });
    } catch {
      // ignore
    }
    this.started = false;
  }

  // --- helpers ---
  #headers() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content,
    };
  }

  #turnSummary(turn) {
    const p = turn.playerMove?.san;
    const c = turn.computerMove?.san;
    return c ? `You played ${p}; computer replied ${c}.` : `You played ${p}.`;
  }

  // --- rendering (self-contained; no server markup needed) ---
  #render() {
    this.element.innerHTML = `
      <div class="border border-slate-100 rounded-2xl bg-white shadow-card flex flex-col h-[30rem] overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
          <h3 class="font-semibold text-sm text-ink-900">Chess Coach</h3>
          <span class="ml-auto text-[10px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">MCP · headless</span>
        </div>
        <div data-agent-chat-transcript
             class="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm text-slate-700">
          <p class="text-slate-400">Make a move and your coach will weigh in — or ask a question below.</p>
        </div>
        <form data-action="submit->agent-chat#ask" class="border-t border-slate-100 p-2.5 flex gap-2">
          <input data-agent-chat-input type="text" placeholder="Ask the coach…"
                 class="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm
                        focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 transition" />
          <button type="submit"
                  class="rounded-xl bg-brand-600 text-white text-sm font-semibold px-3.5 py-2 hover:bg-brand-700 transition">
            Send
          </button>
        </form>
      </div>`;
  }

  // Append a chat line and return the bubble element (so a pending "thinking…" line can be
  // replaced in place when the reply arrives). role ∈ you | coach | move | system.
  #appendMessage(role, text, { pending = false } = {}) {
    const transcript = this.element.querySelector("[data-agent-chat-transcript]");
    // Clear the placeholder on first real message.
    if (transcript.querySelector(".text-slate-400")) transcript.innerHTML = "";

    const wrap = document.createElement("div");
    const styles = {
      you: "ml-auto bg-brand-600 text-white",
      coach: "mr-auto bg-slate-100 text-ink-800",
      move: "mx-auto bg-amber-50 text-amber-700 text-xs italic",
      system: "mx-auto bg-rose-50 text-rose-700 text-xs",
    };
    wrap.className = `max-w-[85%] rounded-2xl px-3 py-2 leading-snug ${styles[role] || styles.coach}`;
    wrap.dataset.role = role;
    if (pending) wrap.dataset.pending = "true";
    wrap.textContent = text;
    transcript.appendChild(wrap);
    this.#scrollToBottom();
    return wrap;
  }

  #scrollToBottom() {
    const transcript = this.element.querySelector("[data-agent-chat-transcript]");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }
}
