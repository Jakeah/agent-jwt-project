import { Controller } from "@hotwired/stimulus";
import { gameStateForPrechat } from "game_state";

// Embeds the Salesforce MIAW (Messaging for In-App and Web) chat widget and wires verified
// identity onto it. Mounted only on authenticated pages (the layout gates on user_signed_in?),
// so by the time this runs we know there's a Devise session backing /identity_token.
//
// Lifecycle (all MIAW events fire on window):
//   1. connect()                         → inject the deployment bootstrap script.
//   2. onEmbeddedMessagingReady          → mint a JWT, setIdentityToken, seed hidden prechat
//                                          fields from the live board (game context).
//   3. onEmbeddedMessagingIdentityTokenExpired → re-mint + setIdentityToken within 30s, or the
//                                          verified session is dropped.
//   4. Sign-out (a [data-agentforce-target="signout"] button) → clearSession to end it.
//
// Config (org id, deployment dev name, ESW site URL, SCRT2 URL, the /identity_token deployment
// key) is passed in as Stimulus values from the registry — no Salesforce specifics hardcoded
// here, so SOMA/MOMA stays a config change.
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
    this.onGameStateChanged = this.seedGameContext.bind(this);

    window.addEventListener("onEmbeddedMessagingReady", this.onReady);
    window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    // Re-seed hidden prechat fields whenever the board changes, so a chat opened mid-game starts
    // with the live position (MIAW captures these at conversation start). Guarded by isReady so we
    // don't call the prechat API before the widget exists.
    window.addEventListener("chess:state-changed", this.onGameStateChanged);

    this.isReady = false;
    this.loadBootstrap();
  }

  disconnect() {
    window.removeEventListener("onEmbeddedMessagingReady", this.onReady);
    window.removeEventListener("onEmbeddedMessagingIdentityTokenExpired", this.onTokenExpired);
    window.removeEventListener("chess:state-changed", this.onGameStateChanged);
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

  // Push the current board into hidden prechat fields → conversation variables the coach reads.
  // Must run after ready and before the conversation begins.
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

  // --- 3. Token expiry → re-mint within the 30s window or the session is cleared ---
  handleTokenExpired() {
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
