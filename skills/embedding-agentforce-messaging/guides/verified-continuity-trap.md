# The verified-user conversation-continuity trap (and how to beat it)

The single hardest MIAW behavior to discover, and the reason a verified agent reads stale/null app
data. Read this whenever: a **verified** user's prechat-backed data is stale or null, but anonymous
users are fine; or you need to end a verified conversation and start a fresh one in-page.

## The trap

**A verified (User-Verification / AUTH) user has ONE persistent conversation. Every later chat-open
RESUMES it — it is never re-created. Hidden prechat is consumed only at conversation CREATION, so
`setHiddenPrechatFields` is a silent no-op on every resume, and the MessagingSession custom fields
stay at whatever the FIRST open captured (or null).**

Contrast (the diagnostic):
- **Anonymous** (`UNAUTH/NA/uid:<random>`): every chat-open = a NEW `ConversationId` → prechat runs at create → data lands EVERY time. ✅
- **Verified** (`AUTH/<config>/uid:<email>`): N chat-opens over hours ALL share ONE `ConversationId`; only the first carried prechat data; every resume → null. ❌ The browser resumes via the `continuityAccessToken` request (visible in DevTools Network at widget boot).

```sql
SELECT CreatedDate, ConversationId, Chess_FEN__c, MessagingEndUser.MessagingPlatformKey
FROM MessagingSession WHERE CreatedDate = TODAY ORDER BY CreatedDate DESC
-- AUTH rows for one subject share ONE ConversationId; only the earliest has non-null custom fields.
```

**The conversation is keyed on the JWT `sub`.** SCRT2 links the verified conversation to the
subject. Re-verifying with the SAME `sub` re-links the SAME conversation, full stop.

## What does NOT break it (all verified, all dead ends)

- **Re-seeding prechat** on every state change / `connect()` — correct but irrelevant; there's no new conversation to consume it.
- **`utilAPI.setSessionContext([...])`** (the documented mid-conversation push) — may be **absent** on the widget build (it was `not a function` in our org). Feature-detect; don't rely on it.
- **`clearSession({shouldEndSession:true})` + `launchChat({shouldStartNewConversation:true})`** — even on Enhanced Web Chat **v2**, this RE-RESUMES the same conversation, because the subject is unchanged. `launchChat`'s flag only starts fresh if the current conversation is already *ended* AND the subject differs.
- **Signing out / back in** — same subject → same conversation.

## ⚠️ launchChat ordering gotcha (if you use it at all)

`utilAPI.launchChat(...)` is callable only **after `onEmbeddedMessagingButtonCreated`**, NOT after
`onEmbeddedMessagingReady`. Calling it on `ready` rejects:
`"API not available before onEmbeddedMessagingButtonCreated event is fired."` After `clearSession`
tears down the button, wait for `buttonCreated` (which fires when the widget rebuilds the button),
THEN `launchChat`.

## FIX A — force a fresh conversation: mint the JWT with a UNIQUE `sub`

A never-before-seen subject makes SCRT2 create a NEW conversation. Use a plus-tag so the subject
still round-trips to the real identity:

```
sub = local+r<nonce>@domain          e.g. jacob+r1782394798@gmail.com
```

Then the routing flow **strips the `+tag`** before matching the Contact / using the email. Formula
(extract after `uid:` first, then canonicalize):
```
Verified_Email =
  IF( AND(FIND("+", raw) > 0, FIND("@", raw) > 0),
      LEFT(raw, FIND("+", raw) - 1) & MID(raw, FIND("@", raw), 255),
      raw )
```
Verified: a `+r` subject produced a brand-new `ConversationId` where every same-email attempt
reused the old one; the flow's strip made `EndUserContactId` resolve to the real Contact.

**Implementation note:** the cleanest productization is to have your token endpoint accept a "reset"
flag and mint the `+r<nonce>` subject server-side, so an in-page "New chat" button just re-verifies
with a fresh subject (clearSession → re-verify with the unique-sub token → new conversation).

## FIX B — make the agent always current regardless of conversation age: per-turn server pull

Often you don't actually need a reset — you need the agent to see live data. Have the agent **pull**
state every reasoning turn (see `passing-app-data.md` → "server-side PULL"), keyed by the user's
**email carried through prechat** (NOT ContactId, which is null in agent context). Pull, not push →
continuity is irrelevant; the coach tracks live state on a resumed conversation.

In practice FIX B is the primary fix (live freshness); FIX A is for "user explicitly wants a clean
slate / new conversation".

## Combine with the republish rule

If you ADD a new prechat field (e.g. the email for FIX B) you MUST republish the ESD AND the field
only lands on a conversation created *after* the republish — so pair the republish with a FIX A
fresh-subject reset to get a clean conversation that carries the new field. (See `passing-app-data.md`
Gotcha 0.)

## Why `@MessagingEndUser.ContactId` won't save you

It arrives NULL in agent context at reasoning time even though the routing flow sets it on the
record and the bot maps it into context. Both the by-name greeting and any ContactId-keyed pull
starve on it. Always key agent-side identity logic on the prechat email instead.

## Rule of thumb

Verified user's prechat fields stale/null but anonymous users fine → continuity trap. **Group
MessagingSessions by `ConversationId` first.** For freshness use the email-keyed per-turn pull (FIX
B); for a clean restart use a unique-subject JWT (FIX A). Never depend on ContactId in agent context.
