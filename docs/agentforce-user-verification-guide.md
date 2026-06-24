# Agentforce User Verification — JWT Reference Guide

Durable, findable-by-name reference for wiring **Salesforce Messaging for In-App and Web
(MIAW) User Verification** to a custom web app. Edit this in place when a lesson is superseded.

**Last verified:** 2026-06-24 (IN PROGRESS — all STATIC config confirmed correct: "Add User
Verification" enabled on the channel (`authMode=Auth`), keyset `jwtIssuer` byte-matches the JWT
`iss`, cert active with x5c, and the registered public key's modulus matches Heroku's signing key.
BUT conversations were still binding UNAUTH due to a CLIENT-side identity-token re-mint loop that
froze the page / opened conversations before the token was set — guard shipped; awaiting a clean
re-test to confirm AUTH binding. See the two ⚠️ notes below. Note the earlier "select the keyset on
the channel" guidance was WRONG — corrected below.)

---

## The two JWTs — don't confuse them

| | Connected App / JWT Bearer OAuth | **User Verification** (this guide) |
|---|---|---|
| Authenticates | the **app** to Salesforce APIs | the **end user** to the chat runtime |
| Consumed by | Salesforce OAuth token endpoint | the MIAW embedded messaging client |
| Delivered | server→server (back channel) | client-side via `setIdentityToken(...)` |
| `aud` | Salesforce login/token URL | the messaging deployment (this guide) |
| Result | an API access token | a chat session bound to a verified Contact |

A Connected App does **not** replace User Verification. Even with one configured, the chat
visitor is anonymous until you pass this identity-token JWT.

## Signing (confirmed)

- Algorithm: **RS256** or RS512 (asymmetric). We use RS256.
- Salesforce stores the **public key**; the app signs with the **private key**.
- The app's private key is never shipped to the browser — the browser only ever receives the
  finished JWT from an authenticated endpoint.

## JWT shape (this app)

Header:
```json
{ "kid": "chess-identity-key-1", "typ": "JWT", "alg": "RS256" }
```
Payload:
```json
{
  "iss": "https://chess-agent-jwt-95c105a581a5.herokuapp.com",
  "sub": "user@example.com",
  "aud": "<verification audience from Setup>",
  "iat": 1781873461,
  "exp": 1781873761
}
```
- `sub` = the user's verified email → mapped to a Salesforce **Contact**. ⚠️ **Confirm in
  Phase 4** the exact required claim set and the precise field that maps `sub` → Contact;
  help.salesforce.com renders client-side and couldn't be extracted headlessly.
- Short TTL (300s). Renew on `onEmbeddedMessagingIdentityTokenExpired` within **30 seconds**.

## Client API (confirmed from developer.salesforce.com/docs/service/messaging-web)

```javascript
window.addEventListener("onEmbeddedMessagingReady", () => {
  embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({
    identityTokenType: "JWT",
    identityToken: "<rs256-jwt>",
  });
});

window.addEventListener("onEmbeddedMessagingIdentityTokenExpired", () => {
  // re-mint + setIdentityToken again within 30s, or the session/user data is cleared
});

// on logout:
embeddedservice_bootstrap.userVerificationAPI.clearSession({ shouldEndSession: true });
```

## Salesforce Setup (confirmed in-org, chess-agent)

1. Create the Agentforce service agent (Chess Coach).
2. **Messaging for In-App and Web channel** (`Chess_Coach_Web`, Enhanced) + **Embedded Service
   deployment**; route to the agent. Fallback Queue is **required** and must support the
   **MessagingSession** object (add a `QueueSobject` row if the queue doesn't list it, or the
   queue won't appear in the picker).
3. **Allowed origins:** add localhost:3000 + the Heroku domain to **Setup → CORS** (the
   *CORS Allowed Origins* list — NOT "Trusted URLs", which is the reverse/CSP direction).
4. **User Verification — JWKS model** (Setup → Service → Embedded Service → **Enhanced Chat
   User Verification**):
   - **JSON Web Key**: upload a JWK file. **MUST include `x5c`** (an X.509 public cert) in
     addition to `kty/kid/alg/n/e` — see the critical gotcha below. The key's embedded `kid`
     must equal the JWT header `kid`.
   - **JSON Web Keyset**: Type **Keys**, **JSON Web Key Issuer** must byte-match the JWT `iss`
     (no trailing slash), attach the key.
5. **No audience field** exists in the key/keyset config — trust is keyed on **issuer +
   signature (kid)**, not `aud`. Set the registry `audience` to the org My Domain as a stable
   recipient.
6. **`sub`→Contact:** there is no mapping field. The verified `sub` is stored in the
   **Messaging Platform Key** of the MessagingEndUser as `v2/iamessage/AUTH/.../uid:<sub>`, and
   the runtime resolves it to a Contact when the conversation is created. The agent reads
   `@MessagingEndUser.ContactId`.
7. Seed a test Contact whose email matches a Rails user (Jordan Player / player@example.com).

### ⚠️ CRITICAL gotcha — the JWK needs `x5c`, or every conversation is silently UNAUTH

Salesforce's JWK upload accepts a key with only `kty/kid/alg/n/e`, but the keyset then
**silently fails to validate tokens** — conversations bind as **Guest** with
`MessagingPlatformKey = v2/iamessage/UNAUTH/NA/uid:<random-uuid>` and `ContactId = null`, even
though the token's signature/claims are perfect and the client's `setIdentityToken` returns OK.
The User Verification *troubleshooting* article lists `kty, kid, alg, **x5c**` as required JWK
members. Fix: generate a self-signed X.509 cert FROM the existing private key (public key
unchanged → already-signed tokens stay valid) and include `x5c` = strict-base64 DER of the cert
in the JWK. We script this in Ruby; the artifacts are `config/keys/identity_jwk.json` (single
JWK, with x5c) and `identity_jwt.cert.pem`.

**Success check (one query):** the verified MessagingEndUser has `ContactId` populated and
`MessagingPlatformKey` contains `AUTH/...` (not `UNAUTH`).

### ⚠️ RESOLVED (2026-06-24) — the "Add User Verification" checkbox is hidden by the WRONG EDIT ENTRY POINT

**This was the last-mile blocker, and the cause was a Setup UI inconsistency, not a missing
feature.** After the x5c fix + republish, conversations were STILL UNAUTH and
`MessagingChannel.IsAuthenticated` stayed `false` because the keyset was never bound to the
channel — and the **"Add User Verification" checkbox appeared to not exist** on the channel.

**Root cause:** *which Edit button you click changes which fields render.*
- ❌ Opening the channel's **detail page** and clicking **Edit on an individual section** (the
  inline/section-level pencil) renders a REDUCED form that **omits** the "Add User Verification"
  checkbox. This is the path we kept taking — so the control looked entirely absent.
- ✅ From the channel **list view** (Messaging Settings → the channels listing), use the **row
  Edit** action (full-record Edit). That renders the COMPLETE form, where **"Add User
  Verification"** is present. Check it, save.

So the checkbox is NOT external-site-only / Experience-Builder-only as previously feared — it's
there for the external-site channel too; the section-level edit on the detail page just doesn't
show it. **Rule of thumb: if a Setup field you expect is missing, re-open the record via full
Edit from the list view before concluding the feature doesn't exist.**

> **CORRECTION (2026-06-24): there is NO "JSON Web Keyset" picker on the channel form.** An earlier
> draft of this note said to "select the keyset" on the channel — that is wrong. The channel's
> "Add User Verification" checkbox only turns verification ON (sets `authMode=Auth` +
> `verifiedUserJwtExpirationTime` in the channel's `embeddedConfig`). The keyset is registered
> SEPARATELY (`PublicKeyCertificateSet` + `PublicKeyCertificate` metadata) and is matched to the
> token by **`jwtIssuer` == the JWT `iss`** — there is no channel→keyset reference field at all.

### How the keyset is actually stored + verified (metadata, not a picker — confirmed 2026-06-24)
The JWKS lives in two retrievable metadata types (NOT queryable as SObjects):
- **`PublicKeyCertificateSet`** (`Chess_Identity_Keyset`): `<jwtIssuer>` MUST byte-match the JWT
  `iss` (no trailing slash); `<type>JWKS</type>`; lists its member certs.
- **`PublicKeyCertificate`** (`chess_identity_key_1`): `isActive=true`; `jsonWebKey` = the JWK
  (kty/kid/alg/n/e + **x5c**). Its embedded `kid` must equal the JWT header `kid`.
Retrieve to verify: `sf project retrieve start --metadata "PublicKeyCertificateSet:<name>"`. All of
this was confirmed correct in-org 2026-06-24 (issuer byte-matches; key pair's modulus matches
Heroku's signing key) — yet conversations still bound UNAUTH, which pointed to the client, below.

### ⚠️⚠️ THE ACTUAL LINK: an **active AuthScheme** ties the keyset to the channel (root cause, 2026-06-24)
The widget error "Something went wrong, please log in and try again" was NOT a token problem — the
JWT was never even evaluated. The SCRT2 `accessToken` request (DevTools → Network, the red request
to `*.salesforce-scrt.com`) returned:

```
{"message":"User verification configuration has no active AuthSchemes."}
```

**Meaning:** the channel has verification turned ON (`authMode=Auth`), and the JWKS keyset
(`PublicKeyCertificateSet` + cert) exists and is correct — but **nothing links them.** The binding
is a separate record Salesforce calls an **AuthScheme** (the "Authorization Method" under User
Verification in Messaging Settings). Without an **active** AuthScheme referencing the keyset, every
token exchange fails BEFORE the signature is checked. This is why all the crypto checks (key pair,
x5c, issuer byte-match) were correct yet useless — they were never reached.

**This supersedes the earlier "the checkbox is the binding" and "no channel→keyset reference" notes:**
the checkbox only sets `authMode=Auth`; the real link is the AuthScheme, and it is NOT deployable
metadata (not in the channel XML, no queryable SObject) — it's created/activated in the **Messaging
Settings UI**.

**FIX (Setup, UI — confirm exact labels in-org, they shift by release):**
- Setup → **Messaging Settings** → the channel (`Chess_Coach_Web`) → **User Verification** section.
- Add an **Authorization Method / AuthScheme** that references the **JSON Web Keyset**
  (`Chess_Identity_Keyset`), and **Activate** it (the error says "no *active* AuthSchemes" — creating
  one isn't enough; it must be active).
- Republish the Embedded Service Deployment; hard-refresh.

**Diagnostic that nails it:** read the SCRT2 `accessToken` response body in the browser Network tab.
"no active AuthSchemes" = this section; a signature/claim message = the token; a 304 + stale token =
the caching bug below.

### ⚠️ A correct keyset is necessary but NOT sufficient — the TOKEN ENDPOINT must not be HTTP-cached
Conversations can STILL bind `UNAUTH` / the widget can show **"Something went wrong, please log in
and try again"** with every static config correct (issuer byte-matches, cert active, x5c present, key
pair matches Heroku's signing key, Contact exists, `authMode=Auth`). Root cause hit 2026-06-24:

**The Rails token endpoint (`/identity_token`) was returning `304 Not Modified`, so the browser
reused a CACHED, now-expired token** and Salesforce rejected it. Signature was never the problem
(the x5c cert's modulus matched the JWK and Heroku's signing key). Two compounding client bugs:
1. **HTTP caching of the credential.** Rails' `Rack::ETag` adds a weak ETag to the 200, so the
   browser sends a conditional request and gets a 304, then serves the stale token from cache.
   `Rack::ETag` skips emitting the ETag **only when the response already has an ETag or
   `Last-Modified` header — it ignores `Cache-Control` entirely** (rack 3.2 `etag.rb#skip_caching?`).
   FIX: set `Cache-Control: no-store` (browser must not store the token) **and** set `Last-Modified`
   so Rack skips the ETag → no 304 → a fresh token every request. (See
   `IdentityTokensController#prevent_token_caching!`.)
2. **Re-mint loop.** When the token IS rejected, Salesforce fires
   `onEmbeddedMessagingIdentityTokenExpired` immediately; an unconditional re-mint loops (40+
   `/identity_token` hits/sec in the Heroku router log) and freezes the tab; conversations created
   during the storm open UNAUTH. FIX: guard the expiry handler (cap re-mints per window).

Also: the ESD **bootstrap script is cached** — after enabling verification, republish the deployment
and hard-refresh, or the browser keeps a pre-verification bootstrap.

**Verify (run AFTER a clean conversation on fixed client code):** the newest MessagingEndUser has
`ContactId` populated and `MessagingPlatformKey` contains `AUTH/...` (not `UNAUTH`). NOTE:
`MessagingChannel.IsAuthenticated` was observed `false` even with `authMode=Auth` set — treat the
MessagingEndUser `AUTH/...` + non-null `ContactId` as the source of truth, not that channel flag.

## Public key (RS256, registered in Salesforce)

`kid: chess-identity-key-1` — matches the JWT header. Private key lives in
`IDENTITY_JWT_PRIVATE_KEY` (Heroku config var) / `config/keys/identity_jwt.private.pem`
(local, gitignored).

```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwlwZF92LsAd8oLlQUy6G
CTX/zxYemh+TXCUmGDzeUwCikNytzVeLeTewQ8obn6sIv9fv5mrAKYFcgr3pWUzn
91xk288gjc/MTb2P21aovjm5Cc0TkIF1lW+rTuVEOejxFOwOEFPwscN014EnvusO
0tbqeQbWuUajFd0gKPy5Naq2yE0uSBHUNQurdaPeODnqVpnfuGciQKgbF7n/ioVP
/7JWHOy6yVs+aImupLEPl/ursG22hAMbqk9gmnpt8aEx8Tsbu9hiXh84vJ2snT2q
imj0fsKBQVoHQX7wbFeqAyzkMJMc5jRAo3CUTXd2VCuVRV2umAL8OjDVcx/HnFF/
YQIDAQAB
-----END PUBLIC KEY-----
```

## SOMA / MOMA

The minter reads `audience` + `key_id` per deployment from `config/agent_deployments.yml`.
Adding an agent (SOMA) or org (MOMA) is a new registry row — no code change. Each org can
register the same public key (or its own; just add a matching `kid`/key entry).
