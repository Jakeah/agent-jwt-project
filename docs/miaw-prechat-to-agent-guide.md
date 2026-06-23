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

## Key fact: "direct-to-agent" IS an Omni-Flow

There is no routing path that bypasses Omni-Channel. The MIAW channel's Routing Type must be
**Omni-Flow**; "direct to agent" just means a trivial flow whose only routing element is a
**Route Work** that routes to the agent. Switching to Omni-Flow **preserves** direct-to-agent
behavior. Parameter Mappings are **inert until the flow exists**, then activate.

## ⚠️ Three gotchas that cost hours (read before debugging)

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
showed every `<actionParameterMappings>` block **empty** — the param→flow-variable binding was blank,
with zero UI indication. Result: the flow's input vars arrive empty → Update Records writes nulls →
the agent field stays None even when routing, flow, and fields are all correct. **Verify by retrieving
the MessagingChannel metadata and checking `<actionParameterMappings>` is non-empty** — do not trust
the UI. Likely cause: mappings created *before* an active routing flow existed don't bind; recreate
them once the flow is active.

## Build checklist for this project (chess FEN/PGN → Chess Coach)

- [x] **MessagingSession custom fields** created + deployed: `Chess_FEN__c`(120), `Chess_PGN__c`(255),
      `Chess_Turn__c`(10), `Chess_Move_Count__c`(10), `Chess_Status__c`(20). (objects/MessagingSession/fields/)
- [x] **Custom Parameters** exist (Chess_FEN etc.; Channel Variable Names match the client keys).
- [ ] **Parameter Mappings** — NOT yet created (we deferred them). Messaging Settings → channel →
      Parameter Mappings → for each: Parameter `Chess_FEN` → **Flow Variable Name** `Chess_FEN`
      (case-exact). Repeat for all 5.
- [x] **Omni-Flow** — `Chess_Coach_Routing` (RoutingFlow, Active) AUTHORED AS METADATA + deployed.
      Update Records → MessagingSession.Chess_*__c (filter Id = recordId) → routeWork (routingType
      Bot, serviceChannelId 0N9g8000000ytHlCAI / sfdc_livemessage, botId 0Xxg8000000mw8DCAQ Chess
      Coach). force-app/main/default/flows/Chess_Coach_Routing.flow-meta.xml. (Originally thought
      UI-only — it's metadata-authorable; iterated via --dry-run then active deploy.)
- [ ] ~~Omni-Flow (UI)~~ superseded by the metadata flow above; remaining flow detail:
      - New Flow → **Omni-Channel Flow** (a.k.a. routing flow; `$Record` = MessagingSession).
      - **5 input variables** (Text, *Available for input*): `Chess_FEN`, `Chess_PGN`, `Chess_Turn`,
        `Chess_Move_Count`, `Chess_Status` — names case-exact to the Parameter Mappings.
      - **Update Records** element: object MessagingSession, record `{!$Record.Id}` (the session),
        set `Chess_FEN__c = {!Chess_FEN}`, … all 5.
      - **Route Work** element: Routing Type **Bot**, Bot = the Chess Coach Agentforce agent.
        (This replaces the old direct-to-agent shortcut, same behavior.)
      - Activate the flow.
- [ ] **Channel Routing Type → Omni-Flow**, select this flow. Messaging Settings → channel → Edit.
- [ ] **Agent Context** → Messaging Session → **Edit Included Fields** → select the 5 `*__c` fields.
- [ ] `.agent`: change the 5 Chess_* vars to `linked string` + `source: @MessagingSession.Chess_FEN__c`
      (etc.). Validate → publish → activate. (Source syntax is correct; it only failed before
      because the field didn't exist.)
- [ ] FLS read on the 5 fields for the agent user (add to Chess_Coach_Actions perm set).
- [ ] E2E: open chat mid-game → agent references the position without being asked for a FEN.

### Minimal Omni-Flow shape
```
[Start: Omni-Channel Flow, $Record = MessagingSession]
   → Update Records: MessagingSession {!$Record.Id}
        Chess_FEN__c={!Chess_FEN}  Chess_PGN__c={!Chess_PGN}  Chess_Turn__c={!Chess_Turn}
        Chess_Move_Count__c={!Chess_Move_Count}  Chess_Status__c={!Chess_Status}
   → Route Work: Routing Type=Bot, Bot=Chess Coach
```

## Mobile exception

For the **Agentforce Mobile SDK** (iOS/Android), hidden prechat works differently — implement the
`AgentforceHiddenPreChatFieldDelegate` (Android) / equivalent iOS protocol, NOT this Parameter-
Mapping/Flow path. Out of scope for this web project.
