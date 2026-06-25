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

// Perceived-latency aid. A coach turn is a SYNCHRONOUS Agent API call: the Agentforce platform
// buffers the WHOLE turn and returns the reply text in one shot at the end (verified 2026-06-25 by
// probing the /messages/stream SSE endpoint — every event, incl. the reply, lands in one burst at
// END_OF_TURN; nothing streams progressively). So real token-streaming buys nothing here. Instead
// we keep the user oriented during the 8–20s wait with an animated, stage-advancing indicator —
// it cycles through plausible phases of the agent's work so the wait reads as active, not frozen.
// The stages are cosmetic (we can't see the agent's true progress); timings are tuned to the
// observed range and the last stage just holds until the reply arrives.
const THINKING_STAGES = [
  "Reading the board",
  "Consulting the engine",
  "Weighing your options",
  "Writing your coaching",
];
const THINKING_STAGE_MS = 2800; // advance roughly every few seconds; holds on the last stage
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
    this.sendQueue = []; // turns/questions waiting behind an in-flight coach request (see #post)

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
    this.#enqueue({ kind: "question", payload: { text } });
  }

  // --- sends ---
  #sendTurn(turn) {
    this.#enqueue({
      kind: "turn",
      turn,
      payload: {
        playerMove: turn.playerMove,
        computerMove: turn.computerMove,
        difficulty: turn.difficulty,
      },
    });
  }

  // Queue a coach request and kick the drainer. A coach turn is a SYNCHRONOUS Agent API call that
  // can take 8–15s, and the server tracks a per-session sequence, so requests MUST run one at a
  // time — never overlap. Previously an in-flight request caused new moves to be DROPPED ("…coach
  // still thinking, skipped"), which desynced the coach from the board: it would comment on a stale
  // move and never catch up. Instead we queue. Consecutive MOVE turns coalesce to the latest (only
  // the current position matters, and it saves credits); QUESTIONS are never dropped or merged.
  #enqueue(item) {
    if (item.kind === "turn") {
      const last = this.sendQueue[this.sendQueue.length - 1];
      if (last?.kind === "turn") {
        // Supersede the queued-but-not-yet-sent move with this newer one (latest board wins).
        this.sendQueue[this.sendQueue.length - 1] = item;
        this.#noteCoalesced();
        this.#drain();
        return;
      }
    }
    this.sendQueue.push(item);
    this.#drain();
  }

  // Process the queue one item at a time. Re-entrant-safe via the busy flag: each completed request
  // calls #drain again, so the loop continues until the queue is empty.
  async #drain() {
    if (this.busy) return;
    const item = this.sendQueue.shift();
    if (!item) return;

    this.busy = true;
    // Show the move summary right before we actually send that turn (so the transcript order
    // matches send order, even after coalescing).
    if (item.kind === "turn") this.#appendMessage("move", this.#turnSummary(item.turn));
    const thinking = this.#startThinking();

    try {
      await this.#ensureSession();
      const res = await fetch(this.messageUrlValue, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(item.payload),
      });
      const data = await res.json().catch(() => ({}));
      thinking.stop(); // halt the animation before swapping in the final content
      if (!res.ok) {
        thinking.el.textContent = data.error || `Coach unavailable (${res.status}).`;
        thinking.el.dataset.role = "system";
      } else {
        thinking.el.textContent = data.reply || "(no reply)";
      }
      thinking.el.removeAttribute("data-pending");
    } catch (err) {
      thinking.stop();
      thinking.el.textContent = "Couldn't reach the coach. Check your connection.";
      thinking.el.dataset.role = "system";
      thinking.el.removeAttribute("data-pending");
    } finally {
      this.busy = false;
      this.#scrollToBottom();
      // Drain the next queued item (a move played while this request was in flight).
      if (this.sendQueue.length) this.#drain();
    }
  }

  // A queued move was superseded by a newer one before it could send — let the user know their
  // intermediate moves were folded into the latest position (collapsed to a single subtle note).
  #noteCoalesced() {
    const transcript = this.element.querySelector("[data-agent-chat-transcript]");
    const last = transcript?.lastElementChild;
    if (last?.dataset?.coalesced === "true") return; // already showing the note; don't stack
    const note = this.#appendMessage("system", "Skipping ahead to your latest move…");
    note.dataset.coalesced = "true";
  }

  // Show an animated "thinking" bubble and advance its label through THINKING_STAGES on a timer,
  // so the synchronous (and lengthy) agent wait reads as active work rather than a frozen line.
  // Returns { el, stop } — stop() clears the timer; the caller then sets el.textContent to the
  // reply/error (which also wipes the animated markup). Honors prefers-reduced-motion (static label).
  #startThinking() {
    const el = this.#appendMessage("coach", "", { pending: true });

    if (prefersReducedMotion()) {
      el.textContent = "Coach is thinking…";
      return { el, stop() {} };
    }

    let stage = 0;
    const dots = '<span class="agent-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    const paint = () => {
      el.innerHTML = `<span class="inline-flex items-center gap-2"><span>${THINKING_STAGES[stage]}</span>${dots}</span>`;
    };
    paint();
    const timer = setInterval(() => {
      // Advance, then hold on the final stage until the reply lands.
      if (stage < THINKING_STAGES.length - 1) {
        stage += 1;
        paint();
      }
    }, THINKING_STAGE_MS);

    return { el, stop: () => clearInterval(timer) };
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
