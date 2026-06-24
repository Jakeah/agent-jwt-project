# Agentforce User Verification — JWT Reference Guide

Durable, findable-by-name reference for wiring **Salesforce Messaging for In-App and Web
(MIAW) User Verification** to a custom web app. Edit this in place when a lesson is superseded.

**Last verified:** 2026-06-24 (END-TO-END verified identity now WORKING — the last-mile
keyset↔channel binding was resolved: the "Add User Verification" checkbox is hidden when you Edit
a section from the channel detail page, but present via full Edit from the channels list view; see
the RESOLVED note below. Also confirmed in-org: the x5c JWK requirement; client API + signing from
developer.salesforce.com).

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
  Verification"** is present. Check it, select the JSON Web Keyset, save.

So the checkbox is NOT external-site-only / Experience-Builder-only as previously feared — it's
there for the external-site channel too; the section-level edit on the detail page just doesn't
show it. **Rule of thumb: if a Setup field you expect is missing, re-open the record via full
Edit from the list view before concluding the feature doesn't exist.**

**Verify:** after binding, a new conversation's MessagingEndUser has `ContactId` populated and
`MessagingPlatformKey` contains `AUTH/...` (not `UNAUTH`); `MessagingChannel.IsAuthenticated` is
`true`. End-to-end verified identity now works.

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
