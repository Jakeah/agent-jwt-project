# SPA / lifecycle gotchas (double-init, ready timing, sign-out)

The MIAW bootstrap loads once and lives on `window`. In a single-page app (React/Turbo/etc.) that
persistence causes a cluster of timing bugs. All verified in a real Turbo (Hotwired) app; the
principles apply to any SPA.

## `onEmbeddedMessagingReady` fires ONCE per window, not per route

The bootstrap persists across SPA navigations, so `onEmbeddedMessagingReady` fires only on the first
page that loaded it — often a page with no relevant app data. On later in-app navigations your
controller re-mounts but the ready event does NOT fire again, so a one-shot "seed on ready" flag
stays false and you never seed prechat for the page the user actually cares about.

**Fix:** don't gate on the one-shot event. Define readiness as "is the API present?" and re-seed on
every mount:
```javascript
isWidgetReady() {
  return typeof window.embeddedservice_bootstrap?.prechatAPI?.setHiddenPrechatFields === "function";
}
// on connect(): if (this.isWidgetReady()) { seedPrechat(); }
```

## Double bootstrap init (the "wonky widget" / `Cannot read properties of undefined`)

On a fast SPA navigation the controller can re-run before the async bootstrap finished loading: the
injected `<script>` element was swapped out by the navigation, but `window.embeddedservice_bootstrap`
isn't set yet — so a guard that checks "element present OR global present" misses BOTH and injects a
**second** bootstrap. Two bootstraps corrupt each other (`Cannot read properties of undefined
(reading 'error')` from `bootstrap.min.js`) and **the second `init()` resets the prechat buffer** →
the conversation opens with null app data even though `setHiddenPrechatFields` ran.

**Fix:** track injection + init on `window` (the only thing that survives the SPA body swap), and
init exactly once:
```javascript
if (window.__eswInjected) { if (window.embeddedservice_bootstrap && !window.__eswInit) init(); return; }
window.__eswInjected = true;
// ...inject script; in init(): if (window.__eswInit) return; ...; window.__eswInit = true;
```
Stash the deployment config on `window` too, so the async `onload` can init even if its originating
controller element was already swapped away.

## Sign-out: `clearSession` is async — await it before navigating away

`userVerificationAPI.clearSession({shouldEndSession:true})` makes a network call to end the
conversation server-side. A sign-out form/button that submits immediately tears down the page before
that request lands → **the verified conversation stays alive** and resumes on next login. Symptom:
one `ConversationId` survives across many "sign out / back in" cycles, never `Ended`.

**Fix:** intercept the submit, `await clearSession(...)`, THEN submit (with a re-entry guard so the
re-submit doesn't loop). Also reset your `window.__eswInit` flag so the next login re-inits cleanly.

NOTE: even a correct clearSession does NOT give a *different* conversation on next login for the same
verified subject — that's the continuity trap (`verified-continuity-trap.md`), a separate issue. This
fix only ensures the conversation actually ends.

## Token endpoint must not be HTTP-cached

If the browser caches the identity-token response (e.g. a `304`), it reuses a stale/expired token →
UNAUTH / "Something went wrong". See `user-verification.md` Gotcha 4 (`no-store` + `Last-Modified` so
no ETag/304; guard the re-mint loop).

## Useful lifecycle events to listen on (for diagnostics)

`onEmbeddedMessagingReady`, `onEmbeddedMessagingButtonCreated`, `onEmbeddedMessagingConversationOpened`,
`onEmbeddedMessagingConversationClosed`, `onEmbeddedMessagingWindowClosed`,
`onEmbeddedMessagingSessionStatusUpdate` (carries `conversationId`, status Waiting/Active/Ended),
`onEmbeddedMessagingIdentityTokenExpired`. Logging these in order is the fastest way to see what the
widget actually did during a reset — it's how the `launchChat`-needs-`buttonCreated` ordering bug was
found.
