# mcpTool:// actions — full reference (reverse-engineered, verified in-org)

Durable detail behind `developing-agentforce-mcp`. Reconstructed from the agent-jwt-project build
log after an `agentforce-adlc` plugin update overwrote the original copy. Everything here was
observed in a live org (`chess-agent`) against a self-hosted Stockfish MCP server on Heroku. Beta /
undocumented at capture (2026-06) — re-confirm before relying on specifics.

## 1. What MCP-in-Agentforce is

- Agent Script supports actions of type `mcpTool` with target `mcpTool://<DeveloperName>`.
- Agentforce connects to **remote** MCP servers over **HTTPS** (Streamable HTTP transport — `POST /mcp` with session handshake; no local stdio). You host the server.
- Reference server that works headless: a native-binary engine over UCI behind an MCP wrapper (we used Stockfish via `brew`/Heroku apt buildpack; the `stockfish` npm WASM package is a trap for servers — it can't locate its `.wasm` headless and the message listener never gets `uciok`/`readyok` in Node).
- Streamable HTTP is **session-based**: keep a `transports[sessionId]` map; create a transport only on a session-less `initialize`, reuse it via the `mcp-session-id` header, and handle GET (SSE) + DELETE (teardown) on `/mcp`. Building a fresh server per request → "Bad Request: Server not initialized".

## 2. Registration (Setup UI, Beta)

- Register on the **MCP Servers** Setup page. For a public server, auth = no-authentication.
- Registration stores the connection as a **NamedCredential** (`SecuredEndpoint`, `Url = https://<host>/mcp`) + **ExternalCredential** (auth protocol Custom → `NoAuthentication`, a param group like `MCPAuthentication`). The server dev-name the agent targets = the **NamedCredential name**.
- The `McpServerDefinition` + `McpServerToolDefinition` records are populated by **tool sync** triggered in the UI — they are NOT hand-authored and NOT created by registering the NamedCredential alone.

## 3. Metadata-authoring path (insufficient on its own, Beta)

- Deploys as `mcpServerDefinitions/<Name>.mcpServerDefinition-meta.xml`.
- **API name: alphanumeric only, 2–40 chars, NO underscores** (`Chess_MCP` rejected; `ChessMCP` ok).
- The deployable base XML is only `<masterLabel>` + `<description>`. A stub deploys (record visible via Tooling API, NOT standard SOQL) but has **no endpoint/URL/NamedCredential/transport/tools fields** — so pure metadata can stub the server but can't wire it to the live endpoint or sync tools. Conclusion: registration + tool sync is a Setup-UI/Connect-API step in this Beta build.

## 4. mcpTool:// target syntax + compiled encoding (verified)

Author in the builder as: `mcpTool://<ServerDevName>/<toolName>` (e.g. `mcpTool://ChessMCP/analyze_fen`).

After the builder binds, the activated planner bundle's decoded agentScript shows encoded targets +
per-tool source IDs (one `McpServerToolDefinition` id each). All four of our tools, verbatim:
```
analyze_fen  → target: mcpTool://mcptoolx5fx5fanalyzex5ffen   source: ac87fbaba830738a5a8426570d3b2998d
best_move    → target: mcpTool://mcptoolx5fx5fbestx5fmove     source: a01f925b1425e355c808d5546c4a23d29
name_opening → target: mcpTool://mcptoolx5fx5fnamex5fopening  source: a133e570ebcdc3216a2006b763f58057f
explain_move → target: mcpTool://mcptoolx5fx5fexplainx5fmove  source: ae85c69cebea2380aa530fdb350022cdb
```
- `_` → `x5f` (hex), plus an `mcptool__` prefix. Holds for every tool.
- Array input bound fine: `name_opening`'s `moves` array → `list[object]` + `complex_data_type_name: "lightning__textType"`.
- Every input carried a generic `label: "string"` (MCP schemas name params generically — fix in the server's tool schema if it matters).

## 5. Agent Script structure note

`target`/`inputs`/`outputs` are NOT valid inline in `reasoning.actions` — that block only WIRES
actions (`name: @actions.x` + `with`/`set`/`available when`). Actions are DEFINED in a separate
subagent-level `actions:` block (sibling of `reasoning:`). (Same as Apex actions.)

## 6. §8 — THE finding: builder-add works, source-publish does NOT (proven at the planner level)

Timeline of how this was nailed down:
- Built a clone agent `Chess_Coach_MCP` identical to production except the 4 engine actions, to isolate the `mcpTool://` variable.
- Added the 4 tools **in the builder** → Save → Commit → Activate (v4). Previewing the **activated** agent returned a real engine eval; the MCP server logs showed `POST /mcp` from Salesforce IPs (`10.77.x.x`). ✅ Native MCP fires.
- Tried to finish from **source**: backfilled the exact 4 action blocks (same target/source IDs) + a guardrail, validated clean, `publish authoring-bundle` → v5. v5's metadata looked great (correct 1XOg… tool-record targets, clean dev names). **But v5 deflected every chess utterance to off_topic/ambiguous and the MCP server logged NO `/mcp` call.**
- Isolation (same org/server/utterances): builder v4 → fires 5/5; source v5 → 0/5; prod v6 (Apex actions, same guardrail) → fires (guardrail exonerated); re-activated v4 → still fires (registration re-sync exonerated). **Only variable: builder-add vs source-publish.**
- **Root cause (builder Preview reasoning trace):** on the failing turn the planner's available-tools list contained ONLY `go_to_off_topic` + `go_to_ambiguous_question`. The 4 MCP tools were present in metadata but **NOT offered to the planner**. Ordered to use a tool with only transitions available → routed to off_topic. It never "chose" off_topic over a tool; the tool wasn't on the menu.
- Decoding the bundles: v4 (pure builder) = 4 mcpTool targets, zero hand-authored comments → tools offered → fires. v5/v6/v7 = contained the SOURCE FILE's action-definition blocks verbatim (incl. comments) → tools in metadata but NOT on the planner menu → deflects. **`publish authoring-bundle` overwrote the builder's working draft, and every later builder version inherited the poisoned baseline.**

**Conclusion: source publish is not inert for MCP — it is actively destructive (overwrites the
builder draft, poisons lineage). The whole MCP action lifecycle is builder/activation-bound, not
source-publish-bound** (compounds: builder drafts aren't retrievable; authoring-bundle preview can't
fire MCP; source publish can't bind MCP).

Recovery: `sf agent activate --api-name <Agent> --version <last-good-builder-version>`. Keep the
`mcpTool://` blocks in source as reference only, behind a loud DO-NOT-SOURCE-PUBLISH warning.

## 7. Activation + preview behavior

- Authoring-bundle **preview** never invokes MCP — looks broken even when correct.
- `sf agent preview start --use-live-actions` rejects MCP with "invalid target ID value" if the tool records weren't persisted/synced.
- Test MCP by **activating** the version, then previewing the activated agent (`--api-name <Agent>`), and confirm via the MCP server's own logs that `POST /mcp` was hit.

## 8. Beta tooling-query gotcha

`sf data query --use-tooling-api "SELECT COUNT() FROM McpServerDefinition"` returned a phantom `1`;
raw `sf api request rest /tooling/query` returned the correct `0`. Trust the raw Tooling REST API for
these Beta entities.

## 9. Portability (SOMA/MOMA)

`mcpTool://` bakes org-coupled `source:` tool-record IDs into the bundle → hurts multi-org
portability. Trade-off vs. an Apex→REST shim (more code, fully portable). Decide per deployment.
