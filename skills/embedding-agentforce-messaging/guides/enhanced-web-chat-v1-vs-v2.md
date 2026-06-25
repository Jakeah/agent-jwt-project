# Enhanced Web Chat v1 vs v2 (and the in-place upgrade)

MIAW "Enhanced Web Chat" has two client versions, tracked as `clientVersion` on the
`EmbeddedServiceConfig` (`WebV1` / `WebV2`). The difference is server-side behavior + a few v2-only
APIs; the embed snippet itself is the same.

## What's the same (verified)

The bootstrap snippet is **byte-identical** across v1 and v2 — same `init(orgId, deploymentName,
siteUrl, {scrt2URL})` signature, same `/assets/js/bootstrap.min.js` path, same org/site/SCRT2 URLs.
After an in-place v1→v2 switch the generated Code Snippet did not change at all. So **upgrading
requires no app/embed code change.** User Verification (identity JWT, keyset, AuthScheme) works the
same on both — the docs are version-agnostic and no v2-specific verification differences were found.

## What's v2-only

- **`utilAPI.launchChat({ shouldStartNewConversation })`** — the `shouldStartNewConversation` flag is v2-only (and only takes effect if the current conversation is already *ended*; see the continuity trap — it still won't beat a same-subject resume).
- **`utilAPI.setSessionContext([...])`** (Context Events API, mid-conversation push) — v2-only, and may still be absent on a given build (feature-detect).

## The v1→v2 upgrade

⚠️ **Salesforce does not publicly document a v1→v2 migration procedure** — no upgrade guide, no
version field in the docs, no Beta-toggle instructions. Confirmed absent across the developer guide
TOC + the Help setup article. Do NOT assume from docs whether it's in-place or a new deployment.

**In practice (verified in-org):** the Setup UI offers a one-click **"Switch to v2"** button on the
deployment, then **Publish**. This is an **in-place** upgrade of the SAME deployment:
- deployment dev name, ESW site URL, org id, SCRT2 URL, bootstrap path — all **unchanged**
- channel, AuthScheme, prechat Custom Parameters + mappings, routing flow — all **carry over**
- `clientVersion` flips `WebV1` → `WebV2` (verify by retrieving `EmbeddedServiceConfig`)

So the in-place switch is low-risk — it does NOT disturb the verified-identity wiring. Verify the
switch took:
```bash
sf project retrieve start --metadata "EmbeddedServiceConfig:<Name>" --target-org <alias>
grep clientVersion .../EmbeddedServiceConfig/<Name>.EmbeddedServiceConfig-meta.xml   # → WebV2
```
Then hard-refresh (the bootstrap is cached). If your org's UI lacks the switch, treat the upgrade
path as unknown and confirm with Salesforce before recreating the deployment (a fresh deployment
would change the dev name/URLs and force redoing the AuthScheme + prechat config).

## Don't over-rely on v2 for the continuity trap

The most common reason people chase v2 is to force a new verified conversation via `launchChat`. It
**doesn't work** even on v2 — the conversation is keyed on the JWT `sub`, so a same-subject relaunch
resumes. Use a unique-subject JWT instead (`verified-continuity-trap.md`). v2 is still worth having,
but it isn't the reset mechanism.
