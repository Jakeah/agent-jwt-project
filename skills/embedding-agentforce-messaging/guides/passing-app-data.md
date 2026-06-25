# Passing live app data into the agent

How to get a value from your web app (a cart total, a chess FEN, a current record id) into an
**Agentforce agent's reasoning**, through MIAW. There are two mechanisms; pick by whether the data
must stay fresh *within* one conversation.

- **Hidden prechat fields** — consumed at conversation CREATION only. Good for "state at chat-open".
- **Server-side pull** — an agent action that re-fetches each turn. Required for "always current" and for verified users (see `verified-continuity-trap.md`).

## The hidden-prechat 5-layer pipeline (ALL layers required)

```
client setHiddenPrechatFields({Key: value, ...})
  → [1] Messaging Settings → Custom Parameter      (declares the field SCRT2 accepts; key case-exact)
  → [2] Parameter Mapping                          (Custom Parameter → Omni-Flow input variable, by matching name)
  → [3] Omni routing Flow: Update Records           (writes the flow var into MessagingSession.<F>__c)
  → [4] Agent Context → Included Fields → <F>__c    (exposes the field to the agent)
  → [5] Agent reads @MessagingSession.<F>__c        (linked var / referenced in instructions)
```

**There is NO direct declarative binding from a prechat field to an agent variable.** In Agent
Script, `source: @context.<field>` is rejected by the compiler — the source must be
`@MessagingSession.<field>__c` (or `@MessagingEndUser.*` / `@VoiceCall.*`), which means the value
must first be written onto a MessagingSession **custom field** by the routing flow. The
client call + the deployment's hidden-field selection are necessary but NOT sufficient.

The almost-always-missing step is **[3]** — teams wire Custom Parameters + Parameter Mappings but
the Omni-Flow has no **Update Records** writing the values onto MessagingSession custom fields.
Internal Splunk signature of this failure: `End - Get Flow Input Parameters for Channel. Returning empty map.`

### Layer details that bite

- **[1] Custom Parameter** — deployable in `MessagingChannel` `<customParameters>`. Channel Variable Name must equal the client key, case-exact.
- **[2] Parameter Mapping** — binds by **matching name**: the metadata is just `<actionParameterMappings><actionParameterName>X</actionParameterName></actionParameterMappings>`. There is NO separate "flow variable name" element (`<flowVariableName>` fails to deploy). Mappings only bind once an ACTIVE routing flow exists; created before that, they appear in the UI but are silently empty — **verify by retrieving the channel metadata, not trusting the UI.**
- **[3] Flow** — must be Routing Type = **Omni-Flow**. "Direct to agent" IS an Omni-Flow whose only routing element is a Route Work to an Agentforce Service Agent. Clone the stock `AiCopilot__LanguageChat` flow ("Save As New Flow") — do NOT hand-author the Route Work (a hand-rolled `routeWork` with `routingType=Bot`/`Copilot` silently falls through to QueueBased routing and the agent never enters; a correct one shows `Status=Active, Owner=Automated Process`).
- **[4] Agent Context** — historically a UI step (Agent Context → Edit Included Fields). **But** declaring the field as a `linked string` in Agent Script source and publishing AUTO-wires it into the `Bot` `<contextVariableMappings>` (verified) — no manual UI step needed when you own the `.agent`.
- **[5] FLS** — the field needs FLS read for BOTH the agent user AND your admin user, or it's invisible in `sObject describe`/the flow picker and looks undeployed.

## ⚠️ GOTCHA 0 (the one that wastes hours) — REPUBLISH the ESD after adding a hidden field

SCRT2 **silently drops any hidden prechat field that is not in the deployment's PUBLISHED field
set.** Deploying the `EmbeddedServiceConfig` metadata is NOT enough — the live widget bootstrap
serves the previously-published set.

Smoking-gun symptom: a NEW field comes back `null` on the MessagingSession while an EXISTING field
(added earlier) lands — through the SAME `setHiddenPrechatFields({...})` call.

Fix:
1. Confirm the field is in **Hidden Pre-Chat Fields → Selected** (metadata deploy adds it; verify).
2. **Publish** the ESD (Setup → Embedded Service Deployments → your deployment → Publish). UI-only.
3. **Hard-refresh** (bootstrap script is cached).
4. The field only lands on a conversation **created AFTER** the republish — a resumed/old conversation won't pick it up (for verified users, combine with a fresh-subject reset — see `verified-continuity-trap.md`).

## The server-side PULL pattern (for "always current" / verified users)

Hidden prechat is frozen at conversation-create. For data that changes during the conversation, or
for verified users whose conversation never re-creates, have the agent **pull** it each turn:

- An **Apex invocable action** (`@InvocableMethod`) the agent runs at the **start of every reasoning
  turn** — put the `run @actions.x` call inside the `reasoning:` block, NOT `before_reasoning`
  (which runs only on subagent ENTRY → captures once, then goes stale).
- The action calls back to your app (Named Credential → your REST endpoint) and returns the live values into mutable agent variables the instructions then reference.
- **Key the pull by a value that reliably reaches the agent — NOT `@MessagingEndUser.ContactId`.**
  ContactId arrives NULL in agent context at reasoning time even when the routing flow set it on
  the record and the bot maps it. Carry the user's email through the prechat pipeline (above) and
  key on that. (This also explains why a by-name greeting that reads ContactId never fires.)

This is "pull, not push" — continuity becomes irrelevant because every turn re-fetches.

## Mobile exception

The Agentforce **Mobile SDK** (iOS/Android) does hidden prechat differently — implement the
`AgentforceHiddenPreChatFieldDelegate` (Android) / equivalent iOS protocol, NOT this
Parameter-Mapping/Flow path. Out of scope for web embeds.
