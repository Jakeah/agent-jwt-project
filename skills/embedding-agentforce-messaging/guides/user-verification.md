# User Verification — the identity JWT, keyset, and AuthScheme

How to make a MIAW conversation run as a **known, verified Contact** instead of an anonymous guest.
Every item here was verified in a live org; the failure modes are real and each looked like a
different bug than it was.

## The two JWTs — do not confuse them

| | Connected App / JWT Bearer OAuth | **User Verification** (this guide) |
|---|---|---|
| Authenticates | the **app** to Salesforce APIs | the **end user** to the chat runtime |
| Delivered | server→server (back channel) | client-side via `setIdentityToken(...)` |
| `aud` | Salesforce token endpoint | the messaging deployment |
| Result | an API access token | a chat session bound to a verified Contact |

A Connected App does NOT replace User Verification. The visitor is anonymous until you pass the
identity-token JWT.

## The identity JWT

- **Algorithm: RS256 or RS512** (asymmetric). Salesforce holds the PUBLIC key; the app signs with the PRIVATE key. The private key never reaches the browser — the browser gets only the finished JWT from an authenticated endpoint.
- Header: `{ "kid": "<key-id>", "typ": "JWT", "alg": "RS256" }`
- Payload: `{ "iss": "<your issuer>", "sub": "<user email>", "aud": "<org My Domain>", "iat": ..., "exp": ... }`
- `sub` = the value resolved to a Contact (typically email). **`sub` also keys the conversation** — see `verified-continuity-trap.md`.
- Short TTL (~5 min). Renew on `onEmbeddedMessagingIdentityTokenExpired` within **30 seconds** or the session/user data is cleared.

Client side:
```javascript
window.addEventListener("onEmbeddedMessagingReady", () => {
  embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({ identityTokenType: "JWT", identityToken });
});
window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", () => { /* re-mint + set within 30s */ });
```

## Setup chain (all required)

1. Agentforce service agent + **Messaging for In-App and Web** channel (Enhanced) + **Embedded Service Deployment**, routed to the agent. The fallback **Queue is required** and must support the **MessagingSession** object (add a `QueueSobject` row or it won't appear in the picker).
2. **CORS:** add your app origins (localhost + prod) to **Setup → CORS → CORS Allowed Origins** (NOT "Trusted URLs" — that's the reverse/CSP direction).
3. **Register the keyset** (JWKS model): `PublicKeyCertificateSet` + `PublicKeyCertificate`.
4. **Turn verification ON** on the channel ("Add User Verification" → `authMode=Auth`).
5. **Create + activate the AuthScheme** (the keyset↔channel link) — the step everyone misses.
6. Seed a Contact whose email matches `sub`.

## ⚠️ Gotcha 1 — the JWK MUST include `x5c`, or every conversation is silently UNAUTH

Salesforce accepts a JWK with only `kty/kid/alg/n/e`, but the keyset then **silently fails to
validate tokens** — conversations bind as Guest (`UNAUTH/NA/uid:<random-uuid>`, ContactId null)
even though the signature/claims are perfect and `setIdentityToken` returns OK. The required JWK
members are `kty, kid, alg, **x5c**`. Fix: generate a self-signed X.509 cert FROM the existing
private key (public key unchanged → already-signed tokens stay valid) and include `x5c` =
strict-base64 DER of the cert in the JWK.

## ⚠️ Gotcha 2 — the "Add User Verification" checkbox is hidden by the WRONG EDIT ENTRY POINT

If the checkbox seems to not exist on the channel:
- ❌ Editing an individual **section** from the channel detail page renders a REDUCED form that omits it.
- ✅ From the channel **list view**, use the **row Edit** (full-record Edit) → the complete form shows "Add User Verification".

**General rule: if a Setup field you expect is missing, re-open the record via full Edit from the list view before concluding the feature doesn't exist.**

## ⚠️ Gotcha 3 — the AuthScheme is the REAL keyset↔channel link (and it's UI-only)

The channel checkbox only sets `authMode=Auth`. The keyset is matched to the token by
`jwtIssuer == JWT iss` — but **nothing links keyset→channel until you create an active AuthScheme.**
Without it, every token exchange fails BEFORE the signature is checked.

Diagnostic — the SCRT2 `accessToken` request (DevTools Network, red request to `*.salesforce-scrt.com`) returns:
```json
{"message":"User verification configuration has no active AuthSchemes."}
```
Fix (Setup, UI — NOT deployable metadata): Messaging Settings → channel → **User Verification** →
**Add User Verification Configuration**. Keyset = your keyset; **Configuration Name** is required
(it becomes the AuthScheme label and appears in the platform key as `AUTH/<name>/uid:<sub>`); check
**Active**; Save. Hard-refresh (no ESD republish needed for this — it's runtime config SCRT2 reads
per token exchange).

Result: the platform key flips from `UNAUTH/NA/uid:<random-uuid>` to
`v2/iamessage/AUTH/<name>/uid:<sub>`.

## ⚠️ Gotcha 4 — a correct keyset is necessary but NOT sufficient: don't HTTP-cache the token

Conversations can still bind UNAUTH / show "Something went wrong, please log in and try again"
with every static config correct, if the **token endpoint is HTTP-cached**:
1. A `304 Not Modified` makes the browser reuse a stale, expired token. (In Rails, `Rack::ETag`
   adds a weak ETag → conditional request → 304. It skips the ETag only when the response already
   carries an ETag OR `Last-Modified` — it ignores `Cache-Control`. Fix: set `Cache-Control: no-store`
   AND `Last-Modified` so no ETag is emitted → no 304 → fresh token every request.)
2. **Re-mint loop:** a rejected token fires `onEmbeddedMessagingIdentityTokenExpired` immediately;
   an unconditional re-mint loops (40+ hits/sec) and freezes the tab; conversations created during
   the storm open UNAUTH. Fix: guard the expiry handler (cap re-mints per window).

Also: the **ESD bootstrap script is cached** — after enabling verification, republish + hard-refresh.

## Which diagnostic for which symptom

Read the SCRT2 `accessToken` response body:
- `"no active AuthSchemes"` → Gotcha 3 (create the AuthScheme).
- a signature/claims message → the token (check x5c/Gotcha 1, issuer byte-match, kid).
- a `304` + stale token reused → Gotcha 4 (caching).

## Success check (org ground truth)

```sql
SELECT ConversationId, EndUserContactId, MessagingEndUser.MessagingPlatformKey
FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 5
-- want: platform key contains AUTH/...  (not UNAUTH)
```
NOTE: `MessagingChannel.IsAuthenticated` was observed `false` even with verification working — trust
the `AUTH/...` platform key, not that flag.

## Keyset stored as metadata (not a UI picker)

- `PublicKeyCertificateSet`: `<jwtIssuer>` MUST byte-match the JWT `iss` (no trailing slash); `<type>JWKS</type>`.
- `PublicKeyCertificate`: `isActive=true`; `jsonWebKey` = the JWK (incl. `x5c`); embedded `kid` == JWT header `kid`.
- There is NO channel→keyset reference field; matching is by issuer + the AuthScheme.
- Retrieve to verify: `sf project retrieve start --metadata "PublicKeyCertificateSet:<name>"`.
