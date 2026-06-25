---
name: developing-agentforce-mcp
description: "Wire native MCP tool actions (mcpTool://) into an Agentforce agent: registering a remote MCP server in Salesforce, the mcpTool:// target syntax, and the CRITICAL rule that MCP actions must be added in the BUILDER (not source-published) or they validate but never fire. TRIGGER when: user adds mcpTool:// actions to an agent, registers an MCP server (McpServerDefinition / MCP Servers Setup page), debugs an agent that deflects to off_topic with no /mcp call, or asks why source-published MCP actions don't work. DO NOT TRIGGER when: building the MCP server itself (a generic MCP/HTTP task), Apex invocable actions (use generating-apex / developing-agentforce), embedding the chat widget or prechat (use embedding-agentforce-messaging), or general Agent Script authoring (use developing-agentforce)."
license: MIT
allowed-tools: Bash Read Write Edit Glob Grep WebFetch AskUserQuestion
metadata:
  version: "1.0"
  source: "Reverse-engineered + verified in-org (chess-agent) during the agent-jwt-project build, 2026-06. Reconstructed after an agentforce-adlc plugin update overwrote the original references/mcp-tool-actions.md. mcpTool:// + McpServerDefinition were Beta/undocumented at capture."
---

# developing-agentforce-mcp: native MCP tool actions in an Agentforce agent

Use this skill when an Agentforce agent should call tools on a **remote MCP server** via native
`mcpTool://` actions. It covers MCP-server registration, the `mcpTool://` target syntax, and — most
importantly — the **builder-vs-source-publish hazard** that makes MCP actions validate cleanly yet
silently never run.

This is MCP-specific. For the agent's general logic/Agent Script use `developing-agentforce`; for
Apex invocable actions use `generating-apex`; for embedding the chat widget use
`embedding-agentforce-messaging`.

## ⚠️⚠️ THE RULE THAT COSTS THE MOST — §8: add MCP actions in the BUILDER, never source-publish

**`sf agent publish authoring-bundle` is NOT inert for `mcpTool://` actions — it is actively
destructive.** A `.agent` source file with `mcpTool://` action definitions will VALIDATE clean,
PUBLISH, and produce correct-looking planner-bundle metadata (right tool-record target IDs, clean
dev names) — and then **the planner never invokes the tools.** The agent deflects every relevant
utterance to `off_topic` / `ambiguous_question`, and the MCP server logs show **zero `/mcp` calls.**

Why (confirmed via the builder Preview reasoning trace): on the failing turn the planner's
*available tool list* contained ONLY the transition tools (`go_to_off_topic`,
`go_to_ambiguous_question`) — the MCP tools were **not offered to the planner at all**, even though
they were present in the metadata. Ordered to "use a tool", with only transition tools available,
it routed to off_topic. The builder does a binding/registration step for `mcpTool://` actions that
`publish authoring-bundle` does NOT; correct metadata + tool IDs are necessary but not sufficient.

Worse, **publish OVERWRITES the builder's working draft** with your source file, so every builder
version built afterward inherits the poisoned baseline (tools present in metadata, absent from the
planner menu).

**Therefore:**
- **Add / edit `mcpTool://` actions ONLY in the Agent Builder** (add action → Save → Commit → Activate).
- **NEVER `publish authoring-bundle`** an agent whose MCP actions you care about. The builder is the source of truth for any MCP-using subagent.
- Keep the `mcpTool://` blocks in your `.agent` as **reference comments only**, with a loud do-not-publish warning. (Apex `apex://` actions in the same agent publish fine — the hazard is `mcpTool://`-specific.)
- Recovery if you poisoned it: `sf agent activate --api-name <Agent> --version <last-good-builder-version>`.

## What native MCP fires looks like (proof, verified)

Once the MCP actions are builder-added and the agent is **activated** (not just preview):
- Asking for an action that needs a tool returns a real tool result (e.g. a live engine eval).
- The MCP server's own logs show a full Streamable-HTTP exchange on **`POST /mcp`** from Salesforce egress IPs (initialize → 202 notify → tools/list → GET SSE → DELETE → the tool call) — NOT the REST paths an Apex shim would use.

⚠️ **Activation is what makes MCP fire.** The authoring-bundle *preview* never invokes MCP (this is
why an in-place migration can look broken). `sf agent preview start --use-live-actions` also rejects
MCP with "invalid target ID value" if the server/tool records weren't persisted. Test MCP by
**activating** the version and previewing the activated agent (`--api-name <Agent>`).

## mcpTool:// target syntax (verified)

- Agent-facing form you author in the builder: `mcpTool://<ServerDevName>/<toolName>` — the server dev name is the **NamedCredential** name created at registration (e.g. `ChessMCP`); the tool is its MCP tool name (e.g. `analyze_fen`).
- After the builder binds it, the compiled/activated bundle shows an **encoded** target + a tool-record source id, e.g.:
  ```
  target: mcpTool://mcptoolx5fx5fanalyzex5ffen    source: ac87fbab...   (one McpServerToolDefinition id)
  ```
  `_` is hex-escaped to `x5f` and the tool gets an `mcptool__` prefix. Array inputs bind as
  `list[object]` + `complex_data_type_name: "lightning__textType"`. Inputs often carry a generic
  `label: "string"` (MCP schemas name params generically — fix server-side if it matters).

## Registering the MCP server (verified)

- Agentforce connects to **remote** MCP servers over **HTTPS** (Streamable HTTP; no local stdio) — you host the server (e.g. on Heroku).
- **Register via the MCP Servers Setup page** (Beta). Registration stores the connection as a **NamedCredential** + **ExternalCredential** pair (e.g. auth protocol Custom → `NoAuthentication` for a public server). The `McpServerDefinition` / `McpServerToolDefinition` records are populated by **tool sync**, not hand-authored.
- **Metadata-authoring is NOT sufficient (Beta):** `McpServerDefinition` deploys as `mcpServerDefinitions/<Name>.mcpServerDefinition-meta.xml`, but the base XML is only `<masterLabel>` + `<description>` — no endpoint/URL/NamedCredential/transport/tools fields. A stub deploys (API name must be **alphanumeric, 2–40 chars, no underscores** — `Chess_MCP` rejected, `ChessMCP` ok) but can't wire the live endpoint. The endpoint + auth + tool discovery is a Setup-UI/Connect-API step.
- After registration, the tool records must actually be **saved/synced** so `McpServerToolDefinition` rows exist with target IDs — without them the agent's `mcpTool://` targets can't resolve.

## ⚠️ Beta tooling-query gotcha

`sf data query --use-tooling-api "SELECT COUNT() FROM McpServerDefinition"` returned a **phantom `1`**;
the raw `sf api request rest /tooling/query` returned the correct `0`. For these Beta entities, trust
the **raw Tooling REST API**, not the CLI SOQL wrapper.

## Portability note (SOMA/MOMA)

`mcpTool://` actions bake org-coupled `source:` tool-record IDs into the bundle, which hurt
multi-org portability — a trade-off vs. an Apex→REST shim (more code, but portable). Weigh this if
the agent must deploy across orgs.

## Confirm against current docs

`mcpTool://` + `McpServerDefinition` were **Beta/undocumented** at capture (2026-06). The platform is
evolving — re-confirm syntax + the registration flow against the current Agentforce docs
(use `fetching-salesforce-docs`) and your org before relying on a specific detail. The §8
builder-vs-publish rule, however, is a behavioral finding proven at the planner level and is the
thing to remember.

## reference

| File | Read when |
|------|-----------|
| `references/mcp-tool-actions.md` | Full detail: registration findings, target encoding, the source-publish saga timeline, and the diagnostic steps that proved §8 |
