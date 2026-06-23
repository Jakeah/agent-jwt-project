# Passing app data into an Agentforce agent via MIAW hidden prechat fields

**Last verified:** 2026-06-23 (mechanism confirmed via internal docs; pipeline build in progress)

How to get a value from your web app (here: the live chess FEN/PGN) into an **Agentforce service
agent**'s reasoning, through **Messaging for In-App and Web (Enhanced Web Chat)** hidden prechat
fields. This is the durable, findable answer to a costly dead-end we hit.

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

## Build checklist for this project (chess FEN/PGN → Chess Coach)

- [ ] Create MessagingSession custom fields: `Chess_FEN__c`, `Chess_PGN__c`, `Chess_Turn__c`,
      `Chess_Move_Count__c`, `Chess_Status__c` (Text; FEN ~120, PGN long-text or 255 to match the
      255 prechat cap, Turn/Status short).
- [ ] Custom Parameters already exist (Chess_FEN etc., Channel Variable Names match the client keys).
- [ ] **Omni-Channel routing Flow** with Parameter Mappings (param → flow input) + an **Update
      Records** element writing each flow var into the matching `MessagingSession.*__c`. NOTE: the
      channel currently routes DIRECTLY to the Agentforce agent (RoutingType None, no flow) — this
      flow is the main new build.
- [ ] Agent Context → Messaging Session → **Edit Included Fields** → select the 5 `*__c` fields.
- [ ] `.agent`: change the 5 Chess_* vars to `linked string` with `source: @MessagingSession.Chess_FEN__c`
      (etc.). Validate → publish → activate.
- [ ] Grant the agent user FLS read on the 5 fields (add to Chess_Coach_Actions perm set).
- [ ] E2E: open chat mid-game → agent references the position without being asked for a FEN.

## Mobile exception

For the **Agentforce Mobile SDK** (iOS/Android), hidden prechat works differently — implement the
`AgentforceHiddenPreChatFieldDelegate` (Android) / equivalent iOS protocol, NOT this Parameter-
Mapping/Flow path. Out of scope for this web project.
