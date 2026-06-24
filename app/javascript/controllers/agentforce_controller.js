import { Controller } from "@hotwired/stimulus";
import { gameStateForPrechat } from "game_state";

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

    window.addEventListener("onEmbeddedMessagingReady", this.onReady);
    window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    // React to board changes: re-seed prechat (helps a chat opened later) AND push live context
    // into an open conversation (the mid-game freshness fix). Both guard on isReady internally.
    window.addEventListener("chess:state-changed", this.onGameStateChanged);

    this.isReady = false;
    this.contextTimer = null;
    this.remintTimes = []; // timestamps of recent re-mints, for the loop guard
    this.remintHalted = false;

    // Only stand up MIAW when the user has the Apex coach selected. In headless mode the MCP
    // coach owns the page and we leave the widget entirely out of the DOM.
    if (this.coachMode() === "miaw") {
      this.loadBootstrap();
    }
  }

  disconnect() {
    window.removeEventListener("onEmbeddedMessagingReady", this.onReady);
    window.removeEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    window.removeEventListener("chess:state-changed", this.onGameStateChanged);
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

  // --- 1. Inject the MIAW bootstrap script (idempotent across Turbo navigations) ---
  loadBootstrap() {
    if (window.embeddedservice_bootstrap || document.getElementById("esw-bootstrap")) {
      // Already loaded this page session — just (re)initialize for the verified user.
      if (window.embeddedservice_bootstrap) this.initEmbeddedMessaging();
      return;
    }

    const script = document.createElement("script");
    script.id = "esw-bootstrap";
    script.src = this.scriptUrlValue;
    script.onload = () => this.initEmbeddedMessaging();
    script.onerror = () => console.error("[agentforce] failed to load MIAW bootstrap script");
    document.body.appendChild(script);
  }

  initEmbeddedMessaging() {
    try {
      const boot = window.embeddedservice_bootstrap;
      boot.settings.language = this.languageValue;
      boot.init(this.orgIdValue, this.deploymentNameValue, this.siteUrlValue, {
        scrt2URL: this.scrt2UrlValue,
      });
    } catch (err) {
      console.error("[agentforce] error initializing MIAW:", err);
    }
  }

  // --- 2. Widget ready → verify the user, then seed the game context ---
  async handleReady() {
    this.isReady = true;
    await this.setIdentityToken();
    this.seedGameContext();
    this.pushLiveContext(); // push current board straight away so the first turn is live
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
    if (!this.isReady) return; // widget not up yet; handleReady will seed once it is
    try {
      const api = window.embeddedservice_bootstrap?.prechatAPI;
      if (api && typeof api.setHiddenPrechatFields === "function") {
        api.setHiddenPrechatFields(gameStateForPrechat());
      }
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

  // Push the live board into the OPEN conversation via the Context Events API, so the coach
  // reasons about the current position on its next turn — not the chat-open snapshot. Sent as a
  // structured _AgentContext value carrying the same keys the agent already reads from prechat.
  pushLiveContext() {
    if (!this.isReady) return;
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
  endSession(event) {
    try {
      window.embeddedservice_bootstrap?.userVerificationAPI?.clearSession({
        shouldEndSession: true,
      });
    } catch (err) {
      console.error("[agentforce] failed to clear session:", err);
    }
    // Don't block the actual sign-out POST — let the button proceed.
  }
}
