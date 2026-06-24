# Passing app data into an Agentforce agent via MIAW hidden prechat fields

**Last verified:** 2026-06-24 (pipeline works for ANONYMOUS conversations; ⚠️ does NOT stay current
for VERIFIED users — see "The verified-user continuity trap" below, a hard architectural limit found
2026-06-24.)

How to get a value from your web app (here: the live chess FEN/PGN) into an **Agentforce service
agent**'s reasoning, through **Messaging for In-App and Web (Enhanced Web Chat)** hidden prechat
fields. This is the durable, findable answer to a costly dead-end we hit.

## ⚠️⚠️ The verified-user continuity trap (root cause, 2026-06-24) — READ THIS FIRST

**Hidden prechat fields are consumed ONLY at conversation CREATION. A verified (User-Verification /
AUTH) user has ONE persistent conversation that every later chat-open RESUMES — it is never
re-created — so `setHiddenPrechatFields` is a silent no-op on every resume, and the
MessagingSession custom fields (`Chess_FEN__c` etc.) stay at whatever the FIRST open captured (or
null).** This is NOT a config bug, NOT an SCRT2 front-door drop (Gotcha 0), NOT a client timing race
— it's how verified continuity works.

**How we proved it (the one query that nails it):** group today's MessagingSessions by
`ConversationId`.
- **Anonymous (`UNAUTH/NA/uid:<random>`):** every chat-open = a NEW `ConversationId` (1 session
  each) → prechat runs at create → `Chess_FEN__c` populates EVERY time. ✅
- **Verified (`AUTH/<config>/uid:<email>`):** 13 chat-opens across 3 hours ALL shared ONE
  `ConversationId` (`0dwg8000000ISQrAAO`). Only the FIRST (its create) carried a FEN; all 12 resumes
  → `Chess_FEN__c` null. ❌ The browser resumes it via the `continuityAccessToken` request (visible
  in DevTools Network when the widget boots).

```sql
SELECT CreatedDate, Chess_FEN__c, ConversationId, MessagingEndUser.MessagingPlatformKey
FROM MessagingSession WHERE CreatedDate = TODAY ORDER BY CreatedDate DESC
-- AUTH rows all share one ConversationId; only the earliest has a non-null Chess_FEN__c.
```

**Why the obvious fixes don't help:** re-seeding prechat on every board change / `connect()` is
correct but irrelevant — there's no new conversation to consume it. The symptom is `null` (not a
stale/opening FEN), because on a resume the field is simply never written, vs. a timing bug which
would capture the opening position.

**The intended mid-conversation fix is also unavailable here:**
`embeddedservice_bootstrap.utilAPI.setSessionContext([...])` (Context Events API) is the *only*
documented way to push context into an ALREADY-OPEN conversation — but on this widget build
`utilAPI.setSessionContext` **is not a function** (console: "utilAPI.setSessionContext not
available"). So for the verified path, BOTH client→agent freshness channels are dead:
prechat (consumed once at create) and setSessionContext (not exposed).

**The fix that works for verified users: an Apex action the agent calls each turn** that re-fetches
live game state server-side (keyed by the verified `@MessagingEndUser.ContactId` → the player's
email → the Rails game record, which is persisted every move). This is pull, not push, so continuity
is irrelevant. It also doubles as the headless-coach grounding path. (Alternative, rejected:
end + recreate the conversation on each open — forces prechat to re-run but destroys the verified
user's conversation history/continuity, which is the whole point of verification.)

**Rule of thumb:** if a verified MIAW user's prechat-backed fields are stale/null but anonymous
users are fine, do NOT chase the prechat pipeline (below) — it's the continuity trap. Group by
`ConversationId` first.

## The dead end (what does NOT work)

There is **no direct declarative binding** from a hidden prechat field to a standalone Agentforce
conversation variable. In Agent Script (`.agent`):

- `Chess_FEN: mutable string = ""` (no source) → never populated; stays at default.
- `linked string` + `source: @context.Chess_FEN` → **compiler error**: source must reference
  `@MessagingSession` / `@MessagingEndUser` / `@VoiceCall`.
- `source: @MessagingSession.Chess_FEN` → **validates but fails publish** ("no access to field
  MessagingSession.Chess_FEN") **unless that custom field actually exists** on MessagingSession.

The client `setHiddenPrechatFields({...})` call and the deployment's Hidden-Pre-Chat-Fields
selection are necessary but **not sufficient** — the values are accepted by SCRT2 but never reach
the agent without the full pipeline below.

## The supported pipeline (5 layers — all required)

```
client setHiddenPrechatFields({Chess_FEN, ...})
  → [1] Messaging Settings → Custom Parameter  (declares the field SCRT2 accepts; key case-exact)
  → [2] Parameter Mapping                       (Custom Parameter → Omni-Flow input variable)
  → [3] Omni-Channel routing Flow: Update Records → writes flow var into MessagingSession.<F>__c
  → [4] Agent Context → Messaging Session → Edit Included Fields → select <F>__c
  → [5] Agent reads it as  @MessagingSession.<F>__c  (linked var) / references it in instructions
```

**The almost-always-missing step is [3]:** teams wire Custom Parameters + Parameter Mappings, but
the Omni-Flow has no **Update Records** element writing the values into **MessagingSession custom
fields**, so the agent never sees them. Internal Splunk signature of this failure:
`End - Get Flow Input Parameters for Channel. Returning empty map.`

So the correct agent-side construct is a **MessagingSession custom field** (`@MessagingSession.X__c`),
NOT a `source: @context.*` prechat binding. (`@context.*` does not exist for this.)

## Prerequisites (no dedicated Beta flag for the core mechanism)

- Einstein Generative AI enabled (Setup → Einstein Generative AI → Einstein Setup).
- The hidden field registered in **BOTH** Messaging Settings → Custom Parameters **and** the
  Embedded Service Deployment → Pre-Chat → **Hidden Pre-Chat Fields → Selected**.
- Agent user has **Agentforce Service Agent Object Access** + **Agentforce Service Agent
  Configuration** permission sets (plus FLS read on the new custom fields).
- **Custom fields created on the MessagingSession object** to hold the values — standard fields
  have no slot for arbitrary prechat data.

## Key fact: "direct-to-agent" IS an Omni-Flow

There is no routing path that bypasses Omni-Channel. The MIAW channel's Routing Type must be
**Omni-Flow**; "direct to agent" just means a trivial flow whose only routing element is a
**Route Work** that routes to the agent. Switching to Omni-Flow **preserves** direct-to-agent
behavior. Parameter Mappings are **inert until the flow exists**, then activate.

## ⚠️ Four gotchas that cost hours (read before debugging)

**0. Pre-Chat must be ACTIVE on the Embedded Service Deployment — this was THE root cause.**
If Pre-Chat is not activated on the ESD, SCRT2 **silently drops every hidden prechat field at the
front door.** The client's `setHiddenPrechatFields({...})` is accepted by the widget (console hooks
show the values being sent) but the values never enter the conversation, so the Omni-Flow's input
variables arrive **null** — and every downstream layer (param mappings, flow vars, Update Records,
FLS, agent linked vars) looks perfectly correct while delivering nothing. We burned hours suspecting
the param-mapping→flow-input hop when the fields were never being let through at all.
Fix: Setup → Embedded Service Deployment → **enable/activate Pre-Chat**; confirm the hidden fields are
in **Hidden Pre-Chat Fields → Selected** (activation and field-selection are two separate switches);
then **Publish the deployment** (ESD changes are invisible to the live site until republished) and
hard-refresh (the bootstrap script is cached). When debugging "values arrive null," check THIS first —
it's upstream of the entire pipeline below.

**1. Don't hand-author the Route Work element — clone the stock flow.**
Routing to an **Agentforce Service Agent** is NOT `routeWork` with `routingType=Bot`+`botId` or
`Copilot`+`copilotId` — both deploy clean but silently fall through to **QueueBased** routing
(session sits `Status=Waiting`, Owner=fallback queue, `PendingServiceRouting.RoutingType=QueueBased`;
the agent never enters). The correct Route Work uses **Route To = "Agentforce Service Agent"** (a
dedicated picker selecting the agent). The org ships a stock flow **"Route Conversations to
Agentforce Service Agents"** (`AiCopilot__LanguageChat`) with this done right, but its managed
internals aren't retrievable/queryable — so **"Save As New Flow"** in Flow Builder to clone it, then
add your Update Records field-writes + input variables. A correctly agent-routed session shows
`Status=Active, Owner=Automated Process`.

**2. A deployed MessagingSession custom field with no FLS is INVISIBLE everywhere.**
The `Chess_*__c` fields deployed (CustomField records exist) but `sObject describe` showed 0 of them
and they didn't appear in the Flow Builder field picker — because FLS was granted only to the *agent*
user. Assign the perm set (or otherwise grant FLS) to **your admin/building user too**, or the fields
look like they never deployed. (`sf org assign permset --name <set>` for the running user.)

**3. Parameter Mappings can show as "present" in the UI but be SILENTLY UNHOOKED.**
The Custom Parameters existed and the mappings *appeared* in Setup, but the retrieved channel metadata
showed every `<actionParameterMappings>` block **empty** — created before an active routing flow
existed, the bindings hadn't taken. Recreating them once the v2 flow was active populated them
(`<actionParameterMappings><actionParameterName>Chess_FEN</actionParameterName></actionParameterMappings>`).
**Verify by retrieving the MessagingChannel metadata and checking `<actionParameterMappings>` is
non-empty** — don't trust the UI. NOTE: a non-empty mapping with only `<actionParameterName>` IS
complete (the binding is by matching name; there is no flow-reference element — see the checklist).
**Caveat learned the hard way:** even a correctly-bound mapping delivers nothing if Pre-Chat is
inactive on the ESD (gotcha 0). When values arrive null, rule out gotcha 0 FIRST — we wrongly
fixated on this mapping for hours while the real cause was the dropped-at-SCRT2 pre-chat fields.

## Build checklist for this project (chess FEN/PGN → Chess Coach)

- [x] **MessagingSession custom fields** created + deployed: `Chess_FEN__c`(120), `Chess_PGN__c`(255),
      `Chess_Turn__c`(10), `Chess_Move_Count__c`(10), `Chess_Status__c`(20). (objects/MessagingSession/fields/)
- [x] **Custom Parameters** exist (Chess_FEN etc.; Channel Variable Names match the client keys).
- [x] **Parameter Mappings** — created + bound. The mapping binds the channel Custom Parameter to the
      flow input variable **by matching name**: the channel metadata is just
      `<actionParameterMappings><actionParameterName>Chess_FEN</actionParameterName></actionParameterMappings>`
      and that name must equal the flow input variable's name (`Chess_FEN`), case-exact. There is NO
      separate flow-reference / "flow variable name" element — `MessagingChannelActionParameterMapping`
      accepts ONLY `<actionParameterName>` (deploying a `<flowVariableName>` child FAILS:
      "Element flowVariableName invalid at this location"). The Setup UI's "Flow Variable Name" field
      writes into `<actionParameterName>`. Mappings only bind once an ACTIVE routing flow exists.
- [x] **Omni-Flow** — `Chess_Coach_Routing_v2` (RoutingFlow, Active), cloned via "Save As New Flow"
      from the stock `AiCopilot__LanguageChat` so the Route Work uses Route To = Agentforce Service
      Agent (see gotcha 1). 5 Text input vars (Available for input): `Chess_FEN`, `Chess_PGN`,
      `Chess_Turn`, `Chess_Move_Count`, `Chess_Status` (case-exact to the Parameter Mappings). Update
      Records → MessagingSession.Chess_*__c (filter Id = recordId) → Route to agent. Vendored at
      force-app/main/default/flows/Chess_Coach_Routing_v2.flow-meta.xml. (The old hand-authored
      `Chess_Coach_Routing` with routingType=Bot/Copilot is obsolete — it fell through to QueueBased.)
- [x] **Channel Routing → the v2 flow.** Channel metadata: `sessionHandlerType=Flow`,
      `sessionHandlerFlow=Chess_Coach_Routing_v2`. Messaging Settings → channel → Edit.
- [x] **Agent Context** → Messaging Session → Edit Included Fields → 5 `*__c` fields selected.
- [x] `.agent`: the 5 Chess_* vars are `linked string` + `source: @MessagingSession.Chess_FEN__c` (etc.).
      Validated, published, active.
- [x] FLS read (+ editable) on the 5 fields, granted to BOTH the agent user and the admin/building
      user (see gotcha 2) via the Chess_Coach_Actions perm set.
- [x] **Pre-Chat ACTIVE on the ESD + the 5 fields in Hidden Pre-Chat Fields → Selected + deployment
      republished** (see gotcha 0 — THE root cause).
- [x] E2E PROVEN: open chat mid-game → coach reasons about the live position without being asked for
      a FEN. ✅ Live 2026-06-23.

### Minimal Omni-Flow shape
```
[Start: Omni-Channel Flow, $Record = MessagingSession]
   → Update Records: MessagingSession {!$Record.Id}
        Chess_FEN__c={!Chess_FEN}  Chess_PGN__c={!Chess_PGN}  Chess_Turn__c={!Chess_Turn}
        Chess_Move_Count__c={!Chess_Move_Count}  Chess_Status__c={!Chess_Status}
   → Route Work: Route To = Agentforce Service Agent = Chess Coach  (clone the stock flow — see gotcha 1)
```

## Mobile exception

For the **Agentforce Mobile SDK** (iOS/Android), hidden prechat works differently — implement the
`AgentforceHiddenPreChatFieldDelegate` (Android) / equivalent iOS protocol, NOT this Parameter-
Mapping/Flow path. Out of scope for this web project.
