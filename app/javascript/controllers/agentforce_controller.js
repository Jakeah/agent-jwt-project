import { Controller } from "@hotwired/stimulus";
import { gameStateForPrechat, hasActiveGame } from "game_state";

// Embeds the Salesforce MIAW (Messaging for In-App and Web) chat widget and wires verified
// identity onto it. Mounted only on authenticated pages (the layout gates on user_signed_in?),
// so by the time this runs we know there's a Devise session backing /identity_token.
//
// Lifecycle (all MIAW events fire on window):
//   1. connect()                         → inject the deployment bootstrap script (MIAW mode only).
//   2. onEmbeddedMessagingReady          → mint a JWT, setIdentityToken, seed hidden prechat
//                                          fields + push live session context.
//   3. onEmbeddedMessagingIdentityTokenExpired → re-mint + setIdentityToken within 30s, or the
//                                          verified session is dropped.
//   4. Sign-out (a [data-agentforce-target="signout"] button) → clearSession to end it.
//
// Two distinct ways game state reaches the agent, because MIAW treats them differently:
//   • setHiddenPrechatFields  — consumed ONLY at conversation creation. Re-seeding keeps a chat
//                               *opened* mid-game correct, but does nothing to a running one.
//   • utilAPI.setSessionContext — Context Events API; pushes context into an ALREADY-OPEN
//                               conversation, so the coach sees the live position on the next
//                               turn (the fix for "the coach is stuck on the opening snapshot").
//                               Eng-flagged as brittle on rapid-fire calls, so we debounce.
//
// Coach-mode toggle: the game page lets the user switch between the Apex coach (MIAW, this
// controller) and the MCP coach (headless Agent API, agent_chat_controller). We only boot MIAW
// in "miaw" mode so the headless path runs clean with no stray widget. The toggle persists the
// mode in localStorage and reloads, so each load sets up exactly one path.
//
// Config (org id, deployment dev name, ESW site URL, SCRT2 URL, the /identity_token deployment
// key) is passed in as Stimulus values from the registry — no Salesforce specifics hardcoded
// here, so SOMA/MOMA stays a config change.
const COACH_MODE_KEY = "coachMode";
const CONTEXT_DEBOUNCE_MS = 400; // collapse a flurry of moves into one settled setSessionContext
// Re-mint loop guard: if Salesforce rejects the identity token, it fires the "expired" event
// immediately; blindly re-minting a token that will also be rejected loops forever and freezes the
// tab. A legit token expires every few MINUTES, so more than a handful of expiries in this window
// means the token is being REJECTED (e.g. no matching Contact for the signed-in email) — stop.
const REMINT_WINDOW_MS = 30000;
const MAX_REMINTS_PER_WINDOW = 5;
// TEMP diagnostics for the v2 "New chat" reset: the conversation keeps resuming instead of starting
// fresh. Logs the exact order of clearSession → ready re-fire → launchChat, plus the widget's own
// conversation/session lifecycle events, so one click reveals where the reset breaks. Remove once fixed.
const RESET_DEBUG = true;
const rlog = (...a) => RESET_DEBUG && console.log("[agentforce:reset]", ...a);

export default class extends Controller {
  static values = {
    orgId: String,
    deploymentName: String,
    siteUrl: String,
    scrt2Url: String,
    scriptUrl: String,
    deployment: String, // registry key → /identity_token?deployment=
    language: { type: String, default: "en_US" },
  };

  connect() {
    // Bind once so add/removeEventListener see the same references.
    this.onReady = this.handleReady.bind(this);
    this.onTokenExpired = this.handleTokenExpired.bind(this);
    this.onGameStateChanged = this.handleGameStateChanged.bind(this);
    this.onButtonCreated = this.handleButtonCreated.bind(this);

    window.addEventListener("onEmbeddedMessagingReady", this.onReady);
    window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    // launchChat is only callable AFTER onEmbeddedMessagingButtonCreated (the widget's own rule —
    // it rejects "API not available before onEmbeddedMessagingButtonCreated event is fired"). The
    // reset path waits for this event before launching a fresh conversation.
    window.addEventListener("onEmbeddedMessagingButtonCreated", this.onButtonCreated);
    // React to board changes: re-seed prechat (helps a chat opened later) AND push live context
    // into an open conversation (the mid-game freshness fix). Both guard on isWidgetReady internally.
    window.addEventListener("chess:state-changed", this.onGameStateChanged);

    // TEMP: trace the widget's own conversation/session lifecycle so we can see exactly what the
    // "New chat" reset does (does the conversation actually END before launchChat runs?).
    if (RESET_DEBUG) {
      this.resetDebugHandlers = {
        onEmbeddedMessagingConversationOpened: (e) => rlog("event: ConversationOpened", e?.detail),
        onEmbeddedMessagingConversationClosed: (e) => rlog("event: ConversationClosed", e?.detail),
        onEmbeddedMessagingWindowClosed: (e) => rlog("event: WindowClosed", e?.detail),
        onEmbeddedMessagingSessionStatusUpdate: (e) => rlog("event: SessionStatusUpdate", e?.detail),
      };
      for (const [name, fn] of Object.entries(this.resetDebugHandlers)) {
        window.addEventListener(name, fn);
      }
    }

    this.contextTimer = null;
    this.remintTimes = []; // timestamps of recent re-mints, for the loop guard
    this.remintHalted = false;

    // Only stand up MIAW when the user has the Apex coach selected. In headless mode the MCP
    // coach owns the page and we leave the widget entirely out of the DOM.
    if (this.coachMode() === "miaw") {
      this.loadBootstrap();
    }

    // CRITICAL (Turbo + persisted widget): the MIAW bootstrap loads ONCE and lives on `window`
    // across Turbo navigations, so `onEmbeddedMessagingReady` fires only on the first page (often
    // the games LIST, where there's no game). When we then Turbo-navigate to a game page, this
    // controller reconnects but the ready event does NOT fire again — so we must seed from
    // connect() if the widget is already up. Otherwise the prechat buffer stays empty and the
    // conversation opens with no game state (Chess_FEN__c null → "I don't see any moves").
    if (this.isWidgetReady()) {
      this.seedGameContext();
      this.pushLiveContext();
    }
  }

  // The widget is usable once its prechat API exists — a reliable, per-page-independent signal
  // (unlike onEmbeddedMessagingReady, which fires only once for a window-persisted bootstrap).
  isWidgetReady() {
    return typeof window.embeddedservice_bootstrap?.prechatAPI?.setHiddenPrechatFields === "function";
  }

  disconnect() {
    window.removeEventListener("onEmbeddedMessagingReady", this.onReady);
    window.removeEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    window.removeEventListener("onEmbeddedMessagingButtonCreated", this.onButtonCreated);
    window.removeEventListener("chess:state-changed", this.onGameStateChanged);
    if (this.resetDebugHandlers) {
      for (const [name, fn] of Object.entries(this.resetDebugHandlers)) {
        window.removeEventListener(name, fn);
      }
    }
    if (this.contextTimer) clearTimeout(this.contextTimer);
  }

  // Current coach mode from localStorage; defaults to the verified MIAW path.
  coachMode() {
    try {
      return window.localStorage.getItem(COACH_MODE_KEY) || "miaw";
    } catch {
      return "miaw"; // localStorage can throw in private-mode/sandboxed contexts
    }
  }

  // --- 1. Inject the MIAW bootstrap script — EXACTLY ONCE per window ---
  // Turbo makes "load once" subtle: on each navigation Turbo swaps <body>, discarding the
  // <script id="esw-bootstrap"> we appended — but `window` (and `window.embeddedservice_bootstrap`
  // once it loads) PERSISTS. So the old guard (check for the element OR the async global) failed: a
  // fast list→game Turbo nav re-ran connect() before the first script finished loading, the element
  // was already gone, the global wasn't set yet → we injected a SECOND bootstrap and called
  // boot.init() twice. Two bootstraps corrupt each other ("Cannot read properties of undefined" in
  // bootstrap.min.js) and the second init RESETS the prechat buffer — so the conversation opens with
  // Chess_FEN__c null even though setHiddenPrechatFields ran with the right FEN. (This is the actual
  // cause of the intermittent null: a full page load = one init = FEN lands; a Turbo nav = double
  // init = FEN lost.) Fix: track injection + init on `window`, the only thing that outlives Turbo.
  loadBootstrap() {
    if (window.__eswBootstrapInjected) {
      // If the script loaded under a previous controller instance but init hasn't run, run it once.
      if (window.embeddedservice_bootstrap && !window.__eswInitialized) this.initEmbeddedMessaging();
      return;
    }
    window.__eswBootstrapInjected = true;

    // Stash the deployment config on window so init still works if this controller's element was
    // swapped out by a Turbo nav before the async script finished loading (the onload below may
    // fire after this instance is disconnected and its Stimulus values are no longer readable).
    window.__eswConfig = {
      orgId: this.orgIdValue,
      deploymentName: this.deploymentNameValue,
      siteUrl: this.siteUrlValue,
      scrt2Url: this.scrt2UrlValue,
      language: this.languageValue,
    };

    const script = document.createElement("script");
    script.id = "esw-bootstrap";
    script.src = this.scriptUrlValue;
    script.onload = () => this.initEmbeddedMessaging();
    script.onerror = () => {
      window.__eswBootstrapInjected = false; // let a later connect retry
      console.error("[agentforce] failed to load MIAW bootstrap script");
    };
    document.body.appendChild(script);
  }

  // Initialize the embedded messaging widget EXACTLY ONCE per window. A second boot.init() resets
  // the prechat buffer (see loadBootstrap), so guard hard on the window flag.
  initEmbeddedMessaging() {
    if (window.__eswInitialized) return;
    try {
      const boot = window.embeddedservice_bootstrap;
      const cfg = window.__eswConfig || {};
      boot.settings.language = cfg.language || this.languageValue;
      boot.init(
        cfg.orgId || this.orgIdValue,
        cfg.deploymentName || this.deploymentNameValue,
        cfg.siteUrl || this.siteUrlValue,
        { scrt2URL: cfg.scrt2Url || this.scrt2UrlValue },
      );
      window.__eswInitialized = true;
    } catch (err) {
      console.error("[agentforce] error initializing MIAW:", err);
    }
  }

  // --- 2. Widget ready → verify the user, then seed the game context ---
  // Fires once per window-persisted bootstrap (typically on the first page). On later Turbo
  // navigations it won't fire again — connect() handles seeding for that case via isWidgetReady().
  // ALSO re-fires after clearSession() (the reset path): the docs guarantee onEmbeddedMessagingReady
  // re-fires once the API is ready for another conversation, which is our hook to re-verify, re-seed,
  // and (if a reset was requested) launch a brand-new conversation.
  async handleReady() {
    rlog("onEmbeddedMessagingReady fired (relaunchAfterReady=" + !!this.relaunchAfterReady + ")");
    await this.setIdentityToken();
    this.seedGameContext();
    this.pushLiveContext(); // push current board straight away so the first turn is live
    // NOTE: launchChat is NOT called here — it's not available until onEmbeddedMessagingButtonCreated
    // (see handleButtonCreated). Calling it from ready rejects with "API not available before
    // onEmbeddedMessagingButtonCreated event is fired", which left the old conversation to just resume.
  }

  // The chat button has been (re)created → launchChat is now callable. This is the correct hook for
  // the reset: after clearSession ends the verified conversation, the widget rebuilds the button and
  // fires this; only now can we launch a brand-new conversation. (Docs: launchChat must be called
  // after onEmbeddedMessagingButtonCreated.)
  handleButtonCreated() {
    rlog("onEmbeddedMessagingButtonCreated fired (relaunchAfterReady=" + !!this.relaunchAfterReady + ")");
    if (this.relaunchAfterReady) {
      this.relaunchAfterReady = false;
      this.launchFreshConversation();
    }
  }

  // Open (maximize) the chat, starting a NEW conversation rather than resuming. shouldStartNewConversation
  // is v2-only; on v1 it's ignored and the widget just opens (still fine — clearSession already ended
  // the old conversation, so v1 will create a new one on next message anyway).
  launchFreshConversation() {
    const util = window.embeddedservice_bootstrap?.utilAPI;
    if (typeof util?.launchChat !== "function") {
      rlog("launchChat NOT available on utilAPI");
      return;
    }
    rlog("calling launchChat({shouldStartNewConversation:true})");
    try {
      const p = util.launchChat({ shouldStartNewConversation: true });
      if (p && typeof p.then === "function") {
        p.then(() => rlog("launchChat resolved")).catch((err) => rlog("launchChat REJECTED:", err?.message || err));
      }
    } catch (err) {
      rlog("launchChat THREW:", err?.message || err);
    }
  }

  // --- Reset the coach: end the current (verified) conversation and start a fresh one IN PAGE ---
  // The documented sequence (no sign-out, no new user): clearSession ends the verified session +
  // clears all messaging data → the widget re-fires onEmbeddedMessagingReady → handleReady re-verifies
  // (setIdentityToken) + re-seeds prechat → launchChat({shouldStartNewConversation:true}) opens a brand
  // new conversation. This is the proper fix for the continuity trap: a fresh conversation re-consumes
  // prechat AND binds to the current agent version, instead of resuming the stale pinned conversation.
  // Wired to a "New conversation" button on the game page (MIAW mode).
  async resetConversation(event) {
    event?.preventDefault();
    const api = window.embeddedservice_bootstrap?.userVerificationAPI;
    if (typeof api?.clearSession !== "function") {
      console.warn("[agentforce] reset unavailable — widget not ready");
      return;
    }
    rlog("resetConversation: calling clearSession({shouldEndSession:true})");
    this.relaunchAfterReady = true; // handleReady (re-fired by clearSession) will launch the new convo
    try {
      const p = api.clearSession({ shouldEndSession: true });
      if (p && typeof p.then === "function") {
        await p;
        rlog("clearSession resolved");
      } else {
        rlog("clearSession returned (non-promise)");
      }
    } catch (err) {
      this.relaunchAfterReady = false;
      rlog("clearSession THREW:", err?.message || err);
    }
  }

  async setIdentityToken() {
    try {
      const res = await fetch(`/identity_token?deployment=${encodeURIComponent(this.deploymentValue)}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) {
        console.error("[agentforce] /identity_token returned", res.status);
        return;
      }
      const { identityTokenType, identityToken } = await res.json();
      window.embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({
        identityTokenType,
        identityToken,
      });
    } catch (err) {
      console.error("[agentforce] failed to set identity token:", err);
    }
  }

  // Board changed → keep both context channels current. Prechat re-seed is immediate (cheap,
  // only matters at next conversation start); the live-context push is debounced because the
  // Context Events API is not guaranteed to settle under rapid-fire calls (eng-flagged).
  handleGameStateChanged() {
    this.seedGameContext();
    this.scheduleLiveContextPush();
  }

  // Push the current board into hidden prechat fields → conversation variables the coach reads.
  // Consumed only at conversation creation, so this keeps a chat OPENED mid-game correct.
  seedGameContext() {
    if (!this.isWidgetReady()) return; // prechat API not up yet; connect()/handleReady seed once it is
    if (!hasActiveGame()) return; // no game on this page → don't seed a blank/start position
    try {
      window.embeddedservice_bootstrap.prechatAPI.setHiddenPrechatFields(gameStateForPrechat());
    } catch (err) {
      console.error("[agentforce] failed to seed game context:", err);
    }
  }

  // Debounce the live-context push so a burst of moves collapses to one settled call.
  scheduleLiveContextPush() {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      this.pushLiveContext();
    }, CONTEXT_DEBOUNCE_MS);
  }

  // Attempt to push the live board into the OPEN conversation via the Context Events API so the
  // coach reasons about the current position on its next turn.
  //
  // ⚠️ NOT FUNCTIONAL on this widget build: `utilAPI.setSessionContext` is NOT exposed here
  // (confirmed 2026-06-24 via instrumented logging — the `typeof === "function"` guard below is
  // always false). It is kept as a no-op + capability check so that if a future widget version ships
  // the API, it lights up automatically. The REAL mid-conversation freshness for the VERIFIED coach
  // is server-side PULL: an Apex action (ChessCoachGetLiveGame) calls back to Rails each turn for the
  // live game, because hidden prechat is consumed once at conversation-create and a verified user's
  // conversation is never re-created (the continuity trap — see docs/miaw-prechat-to-agent-guide.md).
  pushLiveContext() {
    if (!this.isWidgetReady()) return;
    if (!hasActiveGame()) return; // nothing meaningful to push outside a game
    try {
      const util = window.embeddedservice_bootstrap?.utilAPI;
      if (util && typeof util.setSessionContext === "function") {
        util.setSessionContext([
          {
            name: "_AgentContext",
            value: { valueType: "StructuredValue", value: gameStateForPrechat() },
          },
        ]);
      }
    } catch (err) {
      console.error("[agentforce] failed to push live session context:", err);
    }
  }

  // --- 3. Token expiry → re-mint within the 30s window or the session is cleared ---
  // Guarded against a re-mint storm: Salesforce fires this event immediately when it REJECTS a
  // token (e.g. the signed-in email has no matching Contact), so naive re-minting loops forever
  // and freezes the tab. A valid token only expires every few minutes, so > MAX in the window
  // means rejection, not expiry — stop re-minting and surface it once.
  handleTokenExpired() {
    if (this.remintHalted) return;

    const now = Date.now();
    this.remintTimes = this.remintTimes.filter((t) => now - t < REMINT_WINDOW_MS);
    this.remintTimes.push(now);

    if (this.remintTimes.length > MAX_REMINTS_PER_WINDOW) {
      this.remintHalted = true;
      console.error(
        "[agentforce] identity token repeatedly rejected — halting re-mint loop. " +
          "Likely no Salesforce Contact matches the signed-in email (verification enforced).",
      );
      return;
    }

    this.setIdentityToken();
  }

  // --- 4. Sign-out → end the verified session before the Devise session is destroyed ---
  // Wired via data-action on the sign-out button (see layout). Best-effort + synchronous so it
  // runs before navigation.
  async endSession(event) {
    if (this.sessionCleared) return; // resubmit after a completed clear — let the form submit now
    const api = window.embeddedservice_bootstrap?.userVerificationAPI;
    if (typeof api?.clearSession !== "function") return; // nothing to clear; let sign-out proceed

    // clearSession is async (it ends the conversation server-side over the network). The sign-out
    // form would otherwise submit and tear down the page before that request lands, leaving the
    // verified conversation ALIVE — which then resumes on the next login (continuity), pinning the
    // user to the old agent version and stale state. So: hold the form, await the clear, then submit.
    // Without this, ending a verified conversation from the app is effectively impossible.
    event.preventDefault();
    const form = event.target.closest("form");
    try {
      await api.clearSession({ shouldEndSession: true });
    } catch (err) {
      console.error("[agentforce] failed to clear session:", err);
    } finally {
      this.sessionCleared = true; // guard against re-entry when we resubmit
      window.__eswInitialized = false; // a new login should re-init a fresh widget
      form?.requestSubmit ? form.requestSubmit() : form?.submit();
    }
  }
}
