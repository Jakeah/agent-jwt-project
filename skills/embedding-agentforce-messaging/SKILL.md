---
name: embedding-agentforce-messaging
description: "Embed a Salesforce Agentforce agent into a custom web app via Messaging for In-App and Web (MIAW / Enhanced Web Chat, both v1 and v2): the embed bootstrap, User Verification (RS256/RS512 identity JWT), passing live app data to the agent via hidden prechat fields, the verified-user conversation-continuity trap and its fixes, and Enhanced Web Chat v1→v2. TRIGGER when: user embeds embeddedservice_bootstrap, configures an Embedded Service Deployment (ESD) / Messaging channel, sets up MIAW User Verification / setIdentityToken, passes prechat/context data to an agent, debugs UNAUTH conversations or a verified coach reading stale state, or upgrades Enhanced Web Chat v1→v2. DO NOT TRIGGER when: authoring the agent's own logic / Agent Script (use developing-agentforce), wiring native mcpTool:// actions (use developing-agentforce-mcp), Connected App / ECA OAuth for server-to-server API auth (use configuring-connected-apps), or tracing agent reasoning (use trace-agentforce)."
license: MIT
allowed-tools: Bash Read Write Edit Glob Grep WebFetch AskUserQuestion
metadata:
  version: "1.0"
  source: "Reverse-engineered + verified in-org (chess-agent) during the agent-jwt-project build, 2026-06. Every gotcha here was paid for once."
---

# embedding-agentforce-messaging: MIAW / Enhanced Web Chat + verified identity + live app data

Use this skill to **embed an Agentforce agent into a custom web app** and feed it the user's
identity and live app data. It covers the parts that are poorly documented and cost real time:
User Verification (the identity JWT), the hidden-prechat pipeline, the **verified-user
conversation-continuity trap**, and the Enhanced Web Chat **v1↔v2** differences.

This is the embed/channel/identity layer. It does NOT cover the agent's own reasoning/Agent Script
(`developing-agentforce`) or native `mcpTool://` actions (`developing-agentforce-mcp`).

## Scope

| | |
|---|---|
| **In scope** | `embeddedservice_bootstrap` embed; ESD + Messaging channel config; User Verification (RS256/RS512 identity JWT, keyset, AuthScheme); hidden prechat → agent variables; verified-conversation continuity + reset; Enhanced Web Chat v1→v2 |
| **Out of scope** | Agent Script / agent logic (use `developing-agentforce`); `mcpTool://` actions (use `developing-agentforce-mcp`); Connected App/ECA server-to-server OAuth (use `configuring-connected-apps`); reasoning traces (use `trace-agentforce`) |

## The mental model (read first)

Three independent layers, each with its own failure mode:

1. **Embed** — a `<script>` loads `embeddedservice_bootstrap`; you call `init(orgId, deploymentName, siteUrl, {scrt2URL})`. Lives on `window`, persists across SPA navigations.
2. **Identity** — for a *verified* (known Contact) conversation, the browser hands the widget a signed **RS256/RS512 JWT** via `userVerificationAPI.setIdentityToken(...)`. The JWT `sub` becomes the conversation's verified subject.
3. **App data → agent** — live values (e.g. a cart, a game position) reach the agent ONLY through the **hidden-prechat pipeline** (consumed at conversation *creation*), or a server-side **pull** the agent action makes each turn.

Most "it doesn't work" bugs are a layer confusion. Diagnose by layer (see Decision tree).

## The embed bootstrap

```html
<script type="text/javascript">
  function initEmbeddedMessaging() {
    embeddedservice_bootstrap.settings.language = 'en_US';
    embeddedservice_bootstrap.init(
      '00Dxxxxxxxxxxxx',                                  // 15-char org id
      'My_Deployment',                                    // ESD developer name
      'https://<mydomain>.my.site.com/ESW<deployment>',   // ESW site URL
      { scrt2URL: 'https://<mydomain>.my.salesforce-scrt.com' }
    );
  }
</script>
<script src="https://<mydomain>.my.site.com/ESW<deployment>/assets/js/bootstrap.min.js"
        onload="initEmbeddedMessaging()"></script>
```

- **Always copy the live snippet from the deployment's Code Snippet page** rather than hand-write it. The `init` signature + `/assets/js/bootstrap.min.js` path are the same in **v1 and v2** (verified: an in-place v1→v2 switch produced a byte-identical snippet).
- In an SPA, the bootstrap loads once and persists on `window`. `onEmbeddedMessagingReady` fires **once per window**, not per route — see `guides/spa-and-lifecycle.md`.

## Three durable rules (the ones that cost the most)

1. **A verified conversation is keyed on the JWT `sub`.** Re-verifying with the same `sub` always RESUMES the same conversation. Hidden prechat is consumed only at conversation *creation*, so a resumed verified conversation never re-reads prechat → the agent sees stale/null app data. This is the **continuity trap**. → `guides/verified-continuity-trap.md`.
2. **`@MessagingEndUser.ContactId` arrives NULL in agent context at reasoning time** — even when the routing flow sets it on the record and the bot maps it. Do not key agent logic on it. Carry identity (e.g. email) through prechat instead. → `guides/passing-app-data.md`.
3. **After adding any hidden prechat field, REPUBLISH the ESD.** SCRT2 silently drops hidden fields not in the *published* set, and the field only lands on conversations created *after* the republish. → `guides/passing-app-data.md` (Gotcha 0).

## Decision tree (route to the right guide)

- **Conversations bind UNAUTH / "Something went wrong, please log in and try again"** → `guides/user-verification.md`. Read the SCRT2 `accessToken` response body in DevTools Network first: `"no active AuthSchemes"` = missing AuthScheme; a signature/claim message = the token; a `304` = a cached identity token.
- **Verified, but the agent sees stale or null app data** → `guides/verified-continuity-trap.md` (group MessagingSessions by `ConversationId` to confirm). Fix = email-keyed per-turn pull and/or unique-subject reset.
- **Passing live data (FEN, cart, etc.) to the agent at all** → `guides/passing-app-data.md` (the 5-layer prechat pipeline + the republish rule).
- **Need to end + start a fresh conversation in-page** → `guides/verified-continuity-trap.md` (unique-subject JWT; `launchChat`/`clearSession` caveats).
- **v1 vs v2 questions / upgrade** → `guides/enhanced-web-chat-v1-vs-v2.md`.
- **SPA double-init, `onEmbeddedMessagingReady` not firing, sign-out timing** → `guides/spa-and-lifecycle.md`.

## Client API surface (verified method locations)

Methods live on sub-APIs of `embeddedservice_bootstrap`. Getting the sub-API wrong is a common error:

- `userVerificationAPI.setIdentityToken({ identityTokenType:"JWT", identityToken })` — verify the user.
- `userVerificationAPI.clearSession({ shouldEndSession })` — end the verified session + clear all messaging data across tabs. `shouldEndSession:true` ends it server-side; the user must re-verify after.
- `prechatAPI.setHiddenPrechatFields({...})` / `removeHiddenPrechatFields({...})` — hidden prechat (consumed at conversation create; call after `onEmbeddedMessagingReady`, before the conversation begins).
- `utilAPI.launchChat({ shouldStartNewConversation })` — **v2 only**; opens the widget; `shouldStartNewConversation` only takes effect if the current conversation is already *ended*. Must be called after `onEmbeddedMessagingButtonCreated`, not `onEmbeddedMessagingReady`.
- `utilAPI.setSessionContext([...])` — **v2 only** (Context Events API); may be absent on a given build — feature-detect, don't assume.
- `utilAPI.hideChatButton()` / `showChatButton()` / `removeAllComponents()`.

There is **no** `endConversation()` that keeps the session alive, and no `embeddedservice_bootstrap.launch()`. Confirm exact signatures against the official **Enhanced Web Chat Reference** (developer.salesforce.com/docs/service/messaging-web) — use the `fetching-salesforce-docs` skill, the pages are JS-rendered.

## Metadata vs. UI — what's deployable

| Thing | Deployable metadata? |
|---|---|
| ESD form + hidden field selection | `EmbeddedServiceConfig` ✅ (but **must republish in UI** to take effect at runtime) |
| Channel + Custom Parameters | `MessagingChannel` (`<customParameters>`) ✅ |
| Parameter Mappings | bind by matching `<actionParameterName>` (no flow-ref element) ✅ |
| Keyset (JWKS) | `PublicKeyCertificateSet` + `PublicKeyCertificate` ✅ |
| **AuthScheme** (keyset↔channel link) | ❌ UI only (Messaging Settings → User Verification) |
| **ESD Publish** | ❌ UI/Connect action only |
| **v1→v2 switch** | ❌ UI button ("Switch to v2") |
| `clientVersion` (WebV1/WebV2) | read-only in `EmbeddedServiceConfig` (reflects the switch) |
| Agent Context included fields | `Bot` `<contextVariableMappings>` — auto-wired when you declare a `linked` var in Agent Script and publish |

## Verification queries (org ground truth — trust these over the UI)

```sql
-- Is a conversation verified, and which Contact?
SELECT CreatedDate, ConversationId, EndUserContactId, MessagingEndUser.MessagingPlatformKey
FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 10
-- AUTH:  v2/iamessage/AUTH/<ConfigName>/uid:<sub>     UNAUTH: .../UNAUTH/NA/uid:<random-uuid>

-- Continuity trap: AUTH rows for one subject share ONE ConversationId; only the first carries prechat data.
```
`MessagingChannel.IsAuthenticated` can read `false` even when verification works — trust the
MessagingEndUser `AUTH/...` platform key + non-null ContactId instead.

## Reference guides

| Guide | Read when |
|-------|-----------|
| `guides/user-verification.md` | Setting up / debugging the identity JWT, keyset, AuthScheme, UNAUTH conversations |
| `guides/passing-app-data.md` | Getting live app data into the agent (prechat 5-layer pipeline, republish rule, server-side pull) |
| `guides/verified-continuity-trap.md` | Verified coach reads stale state; resetting a verified conversation |
| `guides/enhanced-web-chat-v1-vs-v2.md` | v1 vs v2 capabilities + the in-place upgrade |
| `guides/spa-and-lifecycle.md` | SPA/Turbo double-init, ready-event timing, sign-out/clearSession timing |

> Provenance: every claim was verified in a live org during a real build. Salesforce's MIAW docs
> are thin on these areas; where this skill and the docs disagree, this skill reflects observed
> runtime behavior. Re-confirm against your org + current docs (`fetching-salesforce-docs`) before
> relying on a version-specific detail — the platform is evolving (v2 was Beta-ish at capture time).
