# Build Log — Chess App + Agentforce Verified-Identity Chat

Append-only, timestamped narrative. Newest entries at the bottom. Where git answers
"what changed at the line level, and why?", this answers "what's the running story and
where are we?".

---

## 2026-06-19 06:33 CDT — Project kickoff (Phase 0)

**Goal.** A Ruby on Rails chess app (log in, play the computer, per-move Stockfish analysis)
that embeds a Salesforce Agentforce chat widget (Messaging for In-App and Web / MIAW). When a
user is logged into the Rails app, their identity is passed to the chat via a signed **RS256
JWT** so the Agentforce conversation runs as a *verified* Salesforce Contact. The chess game is
the host surface; the **identity handoff is the real point**.

**Scalability intent.** Reusable reference asset for **SOMA** (Single Org, Multi Agent) and
**MOMA** (Multi Org, Multi Agent). JWT minting + widget embed are **config-driven** via a
deployment registry (`config/agent_deployments.yml`) so adding an org/agent is a config row,
not code.

**Decisions locked with user:**
- Chess: Stockfish WASM in-browser + chess.js (rules). Zero server-side engine.
- Auth: Devise (email/password). Verified email → JWT `sub`.
- Salesforce org: **`chess-agent`** (trailsignup.e8eb68b2222256@salesforce.com), already
  connected. Build agent + MIAW + User Verification from scratch.
- JWT minting: Rails server-side. RS256 private key via `IDENTITY_JWT_PRIVATE_KEY` env var.
- Hosting: **Heroku** (authed as jconnors@salesforce.com), Postgres add-on.

**Grounded facts (from developer.salesforce.com/docs/service/messaging-web):**
- JWT must be **RS256 or RS512** (asymmetric). Salesforce holds the public key; we sign with
  the private key.
- Client API: `embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({ identityTokenType: "JWT", identityToken: "<jwt>" })`.
- Call it inside `window.addEventListener("onEmbeddedMessagingReady", …)`. Renew on
  `onEmbeddedMessagingIdentityTokenExpired` **within 30s**. Logout →
  `clearSession({ shouldEndSession: true })`.
- The two-JWT distinction matters: **Connected App / JWT Bearer OAuth** authenticates the
  *app* to Salesforce APIs; **User Verification JWT** authenticates the *end user* to the chat
  runtime. They do not substitute for each other.

**Open item to confirm in-org (Phase 4):** exact required JWT claims and the precise field
that maps the JWT subject → Contact. help.salesforce.com pages are JS-rendered and could not
be extracted headlessly; will confirm against the live Setup UI.

**Gotcha already hit:** `/usr/bin/rails` is Apple's system stub that prints "Rails is not
currently installed". The real Rails 8.1.3 lives at
`/opt/homebrew/lib/ruby/gems/4.0.0/bin/rails` (gem bindir not ahead of `/usr/bin` on PATH).
Once the app exists, **use `bin/rails`** (the bundler binstub) — it resolves correctly.

**Done this session:**
- Set default `sf` target-org to `chess-agent` (`--global`; prior default `afd360-session-1`
  had an expired token).
- `git init`.
- `rails new . --database=postgresql --css=tailwind --skip-jbuilder` → Rails 8.1.3,
  importmap, Tailwind v4, Propshaft. (Rails 8 also generated Kamal/Docker deploy files —
  we'll remove those in Phase 6 since we deploy to Heroku, not Kamal.)
- Created `docs/`, this build log, project `CLAUDE.md`, and extended `.gitignore`
  (Salesforce DX dirs + RS256 private key).
- `sf project generate --name salesforce` → DX project under `salesforce/` (org metadata
  source-controlled separately from the Rails app).
- `heroku create chess-agent-jwt` → **https://chess-agent-jwt-95c105a581a5.herokuapp.com/**
  (git remote `heroku` added). This `*.herokuapp.com` domain is what gets registered as a
  MIAW **allowed domain** in Phase 4.
- Added Heroku Postgres add-on `essential-0` (~$5/mo max, cheapest paid tier) —
  `postgresql-octagonal-68036`.

**Phase 0 complete.** Next: Phase 1 — Devise + User model + authenticated root.

## 2026-06-19 — Phase 1: Rails skeleton + Devise

- Added `devise` + `jwt` gems. `devise:install`, `devise User`. Set dev mailer host.
- `User has_many :games`. `Game` model: `STARTING_FEN` constant, status enum-by-validation
  (active/checkmate/stalemate/draw/resigned), `belongs_to :user`.
- Routes: `root games#index`; `resources :games` only index/show/create + member `move`
  (persist FEN/PGN) and `finish` (terminal status/result). GamesController is
  `authenticate_user!`-gated and scopes everything through `current_user.games`.
- Layout: dark nav bar (current user email + sign out), flash messages, Tailwind. The
  `games#show` view has the `data-controller="chess"` mount point Phase 2 will hydrate.
- **Verified end-to-end (curl + cookie jar on :3001):** `/` 302→sign_in when anon; `/up` 200;
  signup 303→root; authed `/` 200 renders "My Games"; create game 302→/games/1 and persists
  with correct user + starting FEN. Cleared test data after.

**Phase 1 complete.** Next: Phase 2 — chess board + Stockfish WASM analysis.

## 2026-06-19 — Phase 2: Chess board + Stockfish analysis

**Architecture chosen:**
- `chess.js@1.0.0` (ESM) for rules/legality/FEN/PGN — vendored to `vendor/javascript/`,
  pinned in importmap.
- Custom **self-rendered click-to-move board** (Unicode glyphs + Tailwind grid) — deliberately
  avoided jQuery-era chessboard.js. Lives in `chess_controller.js` (Stimulus).
- **Stockfish** = `stockfish.js@10.0.2` (asm.js). Runs as a **Web Worker** via UCI; wrapped by
  `app/javascript/engine.js` (promise-based `bestMove` / `evaluate`, serialized through a
  queue). Drives both the computer's reply and the eval bar + best-move hint.
- Moves persist via `fetch` PATCH to `/games/:id/move` (FEN+PGN) and `/finish` (terminal).

**Gotchas (paid for once):**
- **`/usr/bin/rails` is an Apple stub** that says "Rails is not currently installed". Real
  binary is the gem bindir / `bin/rails`. The global `rails new` had to use the full gem path;
  everything after uses `bin/rails`.
- **Stockfish threaded WASM needs COOP/COEP cross-origin-isolation headers** — fragile on
  Heroku. Chose the **asm.js single-file build** instead: self-contained (no companion
  `.wasm`), needs no special headers. Trade-off: a bit slower, fine for a demo.
- **Web Workers can't be ESM imports**, so Stockfish does NOT go in importmap. It's served as
  a static file from `public/stockfish/stockfish.js` (stable, undigested URL the Worker can
  load). chess.js/engine.js DO go through importmap (Propshaft, digested).
- **Default Devise fixtures break tests**: generated `test/fixtures/users.yml` has blank
  emails that violate the unique index when `fixtures :all` loads. Emptied users.yml +
  games.yml (we create records per-test in `setup`).
- **Capybara + empty `<span>`**: an empty source square (`<span></span>`) is "not visible", so
  `text: ""` assertions fail. Assert on the *destination* glyph instead (`text: "♙"`).
- **Eval-bar wait**: `assert_selector "[data-chess-evaltext]"` matches the "…" placeholder
  instantly — must assert on the *content* (`text: /[-+]?\d|Mate/, wait: 45`) to actually wait
  for the worker's first score.

**Verified:** system test (headless Chrome, `test/system/chess_game_test.rb`) — sign in →
new game → 64-square board → play e4 → Stockfish replies → eval bar shows a numeric score →
move persists to PGN. 8 assertions, green, ~2.4s.

**Phase 2 complete.** Next: Phase 3 — RS256 JWT identity-token endpoint (config-driven).

## 2026-06-19 — Phase 3: RS256 JWT identity-token endpoint (config-driven)

- **Keypair:** `openssl genrsa 2048` → `config/keys/identity_jwt.{private,public}.pem`.
  `.gitignore` rule narrowed to `*.private.pem` so the **public** key IS tracked (safe,
  reusable for Salesforce) but the private key never is. Private key loads from
  `IDENTITY_JWT_PRIVATE_KEY` env (Heroku) with a dev/test fallback to the local PEM.
- **Registry** `config/agent_deployments.yml` + `AgentDeployment` model (reloads in dev).
  Carries both JWT claims (issuer/audience/key_id/ttl) and embed fields
  (org_id/deployment_name/site_url/scrt2_url). `chess_support` entry is the default; org-side
  values are TODO placeholders until Phase 4.
- **`IdentityToken` service:** one RS256 signer for every org/agent. Claims iss/sub/aud/iat/exp
  + `kid` header. `sub = user.email` (working assumption for Contact mapping; confirm in
  Phase 4).
- **`IdentityTokensController#show`** at `GET /identity_token?deployment=`: Devise-gated (the
  session-gate IS the trust boundary — anon can't get a token). Returns
  `{ identityTokenType: "JWT", identityToken, deployment }`.
- **Design fix:** `AgentDeployment.resolve` raises on an explicit *unknown* deployment (422)
  instead of silently falling back to the default — a typo'd `?deployment=` must not mint a
  token for the wrong audience once MOMA/SOMA has many entries. Missing param → default.
- Corrected registry `issuer` to the real Heroku domain
  (`chess-agent-jwt-95c105a581a5.herokuapp.com`).
- Started `docs/agentforce-user-verification-guide.md` (two-JWT distinction, signing, JWT
  shape, client API, the tracked public key, SOMA/MOMA notes). Marked the ⚠️ open item:
  confirm exact claim set + sub→Contact field in Phase 4.

**Verified:** `bin/rails test` → 7 runs / 21 assertions green. Service mints a JWT that
verifies against the public key with correct claims + TTL; tampered token rejected; endpoint
401→sign_in anon, 200 authed bound to user email, 422 on unknown deployment.

**Phase 3 complete.** Next: Phase 4 — Salesforce agent + MIAW deployment + User Verification
in the `chess-agent` org.

## 2026-06-19 — New requirements: chess-COACH agent + chess MCP server

User wants the agent to be a **chess coach**: it should know the moves played on screen when
the chat opens, and we should give it real chess abilities via an **MCP server**. Decisions:
- **Full proactive coach** — greets the verified user by name, knows the moves, explains the
  position, suggests plans, flags blunders, answers questions.
- **Build our own chess MCP server, host on Heroku** (HTTP transport, Stockfish-backed).

**Research confirmed:**
- **Game context → chat:** `embeddedservice_bootstrap.prechatAPI.setHiddenPrechatFields({...})`,
  called **after `onEmbeddedMessagingReady` and before the conversation begins**. Hidden field
  keys must match parameter-mapped fields on the MIAW channel (Phase 4) → conversation
  variables the agent reads. (Also relevant events: `onEmbeddedMessagingConversationStarted`,
  `onEmbeddedMessagingPreChatLoaded`.)
- **MCP in Agentforce:** Agent Script supports `mcpTool://<DeveloperName>` actions
  (action type `mcpTool`). Agentforce connects to **remote** MCP servers over HTTPS (no local
  stdio) — so we host one. OSS reference: `sonirico/mcp-stockfish` (real UCI Stockfish over
  MCP). Exact Setup-side MCP registration UI to confirm live in Phase 4.

## 2026-06-19 — Phase 2.5: publish game context (chess side)

- `app/javascript/game_state.js`: tiny module singleton snapshot (gameId/pgn/fen/turn/
  moveCount/lastEval/status), mirrored to `window.__chessGameState` for the non-module embed
  snippet. `gameStateForPrechat()` flattens it to the `Chess_*` string fields MIAW prechat
  expects.
- `chess_controller.js` publishes the snapshot on connect + after every user/computer move +
  on each eval. The *consumption* (setHiddenPrechatFields) lands in Phase 5 with the real
  deployment.
- **Verified:** system test now also asserts `window.__chessGameState` carries the live PGN +
  game id. 12 assertions green.

**Phase 2.5 (chess side) complete.** Next: Phase 4.5 — build the chess MCP server.

## 2026-06-19 — Phase 4.5: chess MCP server (`chess-mcp/`)

Node MCP server (separate Heroku app, version-controlled as a subfolder of the main repo).
Streamable HTTP transport (`POST /mcp`), four Stockfish-backed coach tools: `analyze_fen`,
`best_move`, `explain_move`, `name_opening` (+ a compact inline opening book).

**Big gotcha — the `stockfish` npm package is a trap for servers.** It's an emscripten WASM
module meant to load in-browser/in-process; driving it headless in Node fought back hard:
- Spawned as a CLI it can't locate its `.wasm` (`locateFile` not set) and exits when piped
  stdin closes before the async WASM finishes loading.
- Loaded in-process the factory is double-wrapped (`factory()()`), and even then the message
  listener never received `uciok`/`readyok` in our Node 25 runtime.
- **Resolution:** use the **native Stockfish binary over UCI** (what real chess servers do).
  `brew install stockfish` locally; on Heroku the **apt buildpack** reads `Aptfile` and
  installs it to `/app/.apt/usr/games/stockfish` (set `STOCKFISH_PATH` to that). Binary path is
  configurable via `STOCKFISH_PATH`, default `stockfish` on PATH. Each analysis spawns a
  short-lived process — isolated, no cross-request races.

**Second gotcha — Streamable HTTP is session-based.** First attempt built a fresh
server+transport per request → "Bad Request: Server not initialized" because the client's
`initialize` handshake state was thrown away. Fix: keep a `transports[sessionId]` map; create a
transport only on a session-less `initialize`, reuse it (via the `mcp-session-id` header) for
follow-up POSTs, and also handle GET (SSE) + DELETE (teardown) on `/mcp`.

**Third gotcha — eval-swing sign in `explain_move`.** First pass reported a known weak move
(1...f6) as "good" with a *negative* loss. The mover-perspective negation was applied twice.
Fixed: `describeEval` returns White's-perspective cp; multiply by the mover's sign exactly once
(`beforeMoverCp - afterMoverCp`, positive = value given away). Now 1...f6 → inaccuracy (+90cp),
1...e5 → best.

**Verified:** `node --test` → 5/5 green (boots the server, drives a real MCP client over
Streamable HTTP, exercises all four tools incl. the weak-move/best-move discrimination).
Heroku files: `Procfile`, `Aptfile`, `README.md` with deploy steps. Org-side MCP registration
happens in Phase 4.

**Phase 4.5 complete.** Next: Phase 4 — Salesforce org wiring (agent + MIAW + verification +
MCP registration), where the coach instructions and prechat field mapping come together.

## 2026-06-19 — Phase 4 (in progress): coach Agent Spec + MCP deployed to Heroku

- **Agent Spec written + approved:** `salesforce/specs/ChessCoach-AgentSpec.md`. Service agent,
  single `coach` domain subagent + standard guardrails, four `mcpTool://` actions, reads
  prechat conversation variables (`Chess_*`), greets the verified user by name.
- **Prereqs surfaced:** (1) no Einstein Agent User exists in `chess-agent` (service-agent
  requirement — must create one); (2) verified-Contact-name → variable mechanism TBD in-org;
  (3) prechat→variable field API names TBD on the MIAW channel.
- **chess-mcp deployed to Heroku** (decision: MCP first, then build agent against real tools):
  - App **`chess-mcp-coach`** → https://chess-mcp-coach-f6ee6f3510f9.herokuapp.com
  - Buildpacks: `heroku-community/apt` (index 1, reads Aptfile → installs Stockfish 16 to
    `/app/.apt/usr/games/stockfish`) + `heroku/nodejs` (index 2).
    `STOCKFISH_PATH=/app/.apt/usr/games/stockfish`.
  - Deployed via `git subtree push --prefix chess-mcp heroku-mcp main`.
  - **Gotcha:** Heroku Node buildpack rejects an out-of-sync `package-lock.json`. The
    native-Stockfish switch had changed package.json (dropped `stockfish`, added `zod`) without
    regenerating the lockfile → "npm lockfile is not in sync". Fixed by `npm install` + commit.
  - **Verified live:** `/healthz` ok; Stockfish binary present on dyno; a real MCP client over
    the public HTTPS endpoint lists all four tools and `analyze_fen` returns engine analysis
    (+0.40, best e4, full PV). This is the endpoint Agentforce registers against.

## 2026-06-19 — Phase 4: coach agent authored; Einstein user; MCP registration model found

- **Einstein Agent User created:** `chesscoach.agent@chess-agent.demo` (id `005g8000004rM6XAAU`)
  via `sf data import tree` (org has 1002 Einstein Agent licenses). Recorded in the spec as
  `default_agent_user`.
- **Coach agent authored:** `aiAuthoringBundles/Chess_Coach/Chess_Coach.agent`. Service agent,
  `agent_type: AgentforceServiceAgent`. Single `coach` start_agent + `off_topic` /
  `ambiguous_question` guardrails. Dropped the boilerplate escalation subagent (needs an
  Omni-Channel Flow we don't have; a coach doesn't need human handoff). `before_reasoning`
  looks up the player's name from the Contact; instructions greet by name, surface the live
  game (Chess_* vars), and route chess analysis to the MCP tools.
- **`get_player_name` Apex** (`ChessCoachGetPlayerName`) — invocable, queries Contact.FirstName
  from the verified ContactId. Deployed successfully.
- **Salesforce DX MCP Server** (`@salesforce/mcp`) added at **user scope** (`salesforce-dx`,
  follows DEFAULT_TARGET_ORG) — dev tooling for me against the org, available all projects.
  NOTE: distinct from registering *our* chess-mcp as an agent action.
- **KEY FINDING — MCP registration is deployable metadata, not just a Setup UI click.** The
  org exposes `McpServerDefinition` + child `McpServerToolDefinition` /
  `McpServerToolApiDefinition` / `McpServerPromptDefinition` / `McpServerAccess`. Tool defs
  carry MCP annotations (ReadOnly/Destructive/Idempotent/OpenWorld). Endpoint+auth likely via
  a NamedCredential referenced from the McpServerDefinition XML. This means chess-mcp can be
  registered via metadata we author + deploy (and version-control), not hand-clicking.
- **BLOCKER (expected):** the agent's four `mcpTool://` action targets won't resolve (and the
  bundle won't fully validate) until the McpServerDefinition is registered and the tool dev
  names exist. `validate` currently errors only on the 4 MCP actions being "not defined" —
  the rest of the agent (structure, vars, guardrails, get_player_name) is syntactically clean.

### MCP registration — schema discovery findings (metadata-authoring path)

Reverse-engineered the `McpServerDefinition` schema by deploy-and-read against the org (Beta,
undocumented):
- Deploys as `mcpServerDefinitions/<Name>.mcpServerDefinition-meta.xml`. **API name must be
  alphanumeric only, 2–40 chars** (no underscores — `Chess_MCP` rejected, `ChessMCP` ok).
- **The base metadata XML is just `<masterLabel>` + `<description>`.** A minimal stub deploys
  successfully (record id `1g1g800000002ZhAAI`, visible via Tooling API; NOT via standard
  SOQL). No endpoint/URL/NamedCredential/transport/tools fields in the deployable metadata.
- Child objects exist (`McpServerToolDefinition` with MCP annotations, `McpServerToolApiDefinition`
  with ApiSource/ApiIdentifier/Operation, `McpServerAccess`) but are populated by **tool sync**,
  not authored by hand.
- **Conclusion:** the endpoint URL + auth (NamedCredential) + tool discovery/sync is a
  **Setup-UI registration / Connect-API runtime step**, not deployable-metadata fields in this
  Beta build. Pure-metadata authoring stubs the server but can't wire it to the live endpoint.
  → Decision point surfaced to user: register via Setup UI (then capture synced tool dev names
  to wire the agent's `mcpTool://` targets) vs. ship coach-without-MCP first.

### MCP registered via Setup UI + agent validates clean

- **User registered the MCP server in Setup** (MCP Servers page, no-auth). It stored the
  connection as a **NamedCredential `ChessMCP`** (SecuredEndpoint, Url =
  `https://chess-mcp-coach-f6ee6f3510f9.herokuapp.com/mcp`) + **ExternalCredential `ChessMCP`**
  (auth protocol Custom → `NoAuthentication`, param group `MCPAuthentication`). No queryable
  `McpServerDefinition`/tool records surfaced via SOQL — the connection lives in the
  NamedCred/ExternalCred pair.
- **Agent Script structure gotcha (important):** `target`/`inputs`/`outputs` are NOT valid
  inline in `reasoning.actions` — that block only *wires* actions (`name: @actions.x` +
  `with`/`set`/`available when`). Actions are **defined** in a separate **subagent-level
  `actions:` block** (sibling of `reasoning:`, placed after it) with `target`/`inputs`/
  `outputs`. Split the coach accordingly.
- **MCP target format confirmed:** `mcpTool://ChessMCP/<toolName>` (server dev-name = the
  NamedCredential name `ChessMCP`; tool = its MCP tool name, e.g. `analyze_fen`).
- **`sf agent validate authoring-bundle --api-name Chess_Coach` → status 0, zero errors.**
  The coach compiles with all four live `mcpTool://` actions + the Apex `get_player_name`.

### Live-preview blocker: MCP tools displayed in UI but NOT persisted as records

- `sf agent preview start --use-live-actions` (status 4) rejects the MCP actions:
  *"The MCP action 'ChessMCP/analyze_fen' has an invalid target ID value."* Same for all four.
  Tried `mcpTool://ChessMCP/<tool>` and `mcpTool://<tool>` — both compile but fail this deeper
  runtime validation. The runtime wants a resolvable **tool target ID**.
- **Root cause (confirmed via raw Tooling REST API — ground truth):**
  `SELECT ... FROM McpServerDefinition` → **0 records**; `McpServerToolDefinition` → **0 records**.
  Despite the MCP Servers Setup page *displaying* the 4 tools, nothing was persisted. The
  registration created the NamedCredential + ExternalCredential (the *connection*) but the
  server + tool records were never saved/imported → no IDs for the agent to target.
  - ⚠️ CLI tooling-query gotcha: `sf data query --use-tooling-api "SELECT COUNT()..."` returned
    a phantom `1`; the raw `sf api request rest /tooling/query` returns the correct `0`. Trust
    the REST API for these Beta entities, not the CLI SOQL wrapper.
- **Next:** the MCP server registration needs to be *completed/saved* in Setup (or the tools
  explicitly enabled/imported) so `McpServerToolDefinition` records exist with target IDs.
  Then re-target the agent actions to the real IDs and re-run live preview.

### Decision: ship coach WITHOUT MCP now; coach validated in live preview

- Per user: comment out the 4 `mcpTool://` actions (refs + definitions kept as comments for
  easy re-enable) so the coach ships now; revisit MCP binding later. Instructions updated to
  coach from the LLM's own chess knowledge (honest that evals are estimates).
- **Permissions gotcha:** first live-preview after disabling MCP failed with *"Unable to access
  the Salesforce Agent APIs"* (error names the org admin user, but root cause is the **Einstein
  Agent User**). Fixed: `sf org assign permset --name AgentforceServiceAgentUser
  --on-behalf-of chesscoach.agent@chess-agent.demo`.
- **Coach VALIDATED in live preview** (`--use-live-actions`, session started status 0):
  - Greeting → warm welcome + invites a chess question.
  - "1.e4 e5 2.Nf3 Nc6 3.Bb5, what's this opening + my plan?" → correctly named the **Ruy
    López**, explained White's plan (pressure e5, 0-0/Re1/c3/d4, the ...a6 question, c6
    exchange decision). Strong, specific coaching from the LLM alone.
  - Off-topic ("weather in Paris?") → cleanly redirected to chess (guardrail works).
- The name-greeting + game-context paths (ContactId / Chess_* vars) activate in the real MIAW
  embed (preview has no MessagingSession), validated in Phase 5/E2E.
- **Chess Coach PUBLISHED + ACTIVATED** in chess-agent. Committed (`c93c52b`).

## 2026-06-22 — PAUSED here. Pick up at: MIAW deployment + User Verification

State of the world:
- ✅ Rails chess app (Devise, Stockfish, games) — local, tested. NOT yet on Heroku.
- ✅ RS256 identity-token endpoint + deployment registry (`config/agent_deployments.yml`).
  Public key in `config/keys/identity_jwt.public.pem` + in
  `docs/agentforce-user-verification-guide.md`. Private key gitignored / Heroku config var.
- ✅ chess-mcp deployed: **chess-mcp-coach** (https://chess-mcp-coach-f6ee6f3510f9.herokuapp.com),
  registered in org as NamedCredential/ExternalCredential `ChessMCP`. MCP-as-agent-action
  binding deferred (Beta wall).
- ✅ Chess Coach agent published + active in **chess-agent**. Einstein Agent User
  `chesscoach.agent@chess-agent.demo` + `AgentforceServiceAgentUser` permset.
- ✅ Heroku apps: **chess-agent-jwt** (Rails, not deployed yet) + **chess-mcp-coach** (live).

**NEXT (Phase 4 remainder — mostly Setup UI, user chose to do later):**
1. MIAW channel + **Embedded Service deployment**; attach the **Chess Coach** agent.
2. **Allowed domains:** `http://localhost:3000`, `https://chess-agent-jwt-95c105a581a5.herokuapp.com`.
3. **User Verification:** register the RS256 **public key** (in the guide doc / public.pem,
   `kid: chess-identity-key-1`). ⚠️ Confirm in Setup: exact required JWT claims + the field
   that maps `sub` (the user's email) → **Contact**. Update `IdentityToken` service / registry
   `audience` to whatever Setup expects.
4. **Parameter-mapped prechat fields** on the channel for the conversation variables:
   `Chess_PGN, Chess_FEN, Chess_Turn, Chess_Move_Count, Chess_Status` (the agent already
   declares these mutable vars; prechat must populate them).
5. Capture the deployment **bootstrap snippet** (org id, ESW deployment name, ESW URL, SCRT2
   URL) → fill into `config/agent_deployments.yml` (the `chess_support` entry's TODO fields).
6. Seed a test **Contact** whose email matches a Rails user (for the verified-greeting path).

**THEN Phase 5:** embed the bootstrap snippet in the Rails authenticated layout +
`agentforce_controller.js`: `setIdentityToken` on `onEmbeddedMessagingReady`,
`setHiddenPrechatFields` with the game state, re-mint on expiry, `clearSession` on logout.
**Phase 6:** deploy Rails to chess-agent-jwt. **Phase 7:** architecture doc + demo script.
**To revisit MCP:** uncomment the 4 mcpTool actions in `Chess_Coach.agent` once the
McpServerToolDefinition target-ID binding resolves; re-validate + re-publish.

## 2026-06-22 — Resume Phase 4b: docs research + autonomous prep done; Setup runbook next

Picked the project back up at MIAW + User Verification. Did the parts that don't need the
Setup UI; the rest is a click-through runbook handed to the user (same division of labour as
the MCP registration — Beta-era MIAW/User-Verification config isn't cleanly deployable metadata).

### Doc research — exact JWT claim set is deliberately NOT in public docs
- Confirmed from `developer.salesforce.com/docs/service/messaging-web/guide/user-verification`
  + the `userVerificationAPI` reference: **only** RS256/RS512 + the client API
  (`setIdentityToken({identityTokenType:"JWT", identityToken})`) are documented. The required
  **claim set and the subject→Contact mapping are NOT published** — they're resolved in the
  org's Messaging Settings at registration time. (Help article `service.user_verification.htm`
  renders, but is a hub: token-based claim specifics live behind the Setup UI, not the doc.)
  → So the "confirm exact claims + sub→Contact field" open item is resolved **empirically in
  Setup**, not from docs. Working claim set stays: iss / sub(=email) / aud / iat / exp + kid header.
- Stood up the `fetching-salesforce-docs` skill's isolated Playwright runtime
  (`~/.claude/.fetching-salesforce-docs-runtime`, venv + chromium) — one-time, reusable.

### Autonomous prep completed
- **Org id captured:** `00Dg8000008l1AcEAI` (chess-agent,
  trailsignup.e8eb68b2222256@salesforce.com, instance
  `https://trailsignup-e8eb68b2222256.my.salesforce.com`). Filled into
  `config/agent_deployments.yml` `chess_support.org_id` (was a TODO).
- **Test Contact seeded:** Jordan Player / player@example.com (`003g800000KXhnRAAT`) — matches
  the local dev Rails user (`player@example.com`). This is the verified-greeting target: the
  coach's `get_player_name` returns "Jordan" once `ContactId` flows from MessagingEndUser.
- **Confirmed clean slate:** `SELECT ... FROM MessagingChannel` → 0 records. No MIAW channel
  exists yet, so Phase 4b starts fresh.
- ⚠️ CLI gotcha (again): the `sf` autoupdate warning prints to **stdout** and breaks
  `| python3 json.load`. Set `SF_AUTOUPDATE_DISABLE=true` for clean JSON.

### Still TODO in registry (filled from the Setup bootstrap snippet in step 5 below)
`deployment_name`, `site_url`, `scrt2_url`, `audience`. org_id + issuer + key_id already set.

### NEXT — Setup-UI runbook (user drives; I capture results)
1. Messaging Settings → new **Messaging for In-App and Web** channel + **Embedded Service
   deployment**; attach **Chess Coach** agent. Capture ESW dev name + bootstrap snippet.
2. Allowed domains: `http://localhost:3000`,
   `https://chess-agent-jwt-95c105a581a5.herokuapp.com`.
3. **User Verification:** Add User Verification on the channel; upload the RS256 public key
   (`config/keys/identity_jwt.public.pem`, label/kid `chess-identity-key-1`). Read back the
   exact required claims + the **audience** value Setup expects + the **sub→Contact** mapping
   field. Update registry `audience` + IdentityToken if different from email-as-sub.
4. Parameter-mapped prechat fields → conversation vars: Chess_PGN/FEN/Turn/Move_Count/Status.
5. Capture bootstrap snippet → fill registry chess_support TODO fields.
6. (Done early) Seed test Contact — ✅ Jordan Player above.

## 2026-06-22 — Phase 4b LIVE: MIAW channel + User Verification configured (with user, Setup UI)

Worked the Setup UI together. Resolved the long-standing "exact claims + sub→Contact + audience"
open item **empirically** — the published docs deliberately omit it; the org's Setup model is
the source of truth. Findings below are the real, in-org answer.

### MIAW channel + Embedded Service deployment — CREATED
- **MessagingChannel** `Chess_Coach_Web` (`0Mjg8000000J9pBCAS`), Type **Embedded Messaging**,
  Platform **Enhanced**, active. Messaging Platform Key `0d092d88-c89c-4b13-8155-6dff51032bc2`.
- Routing: **Agentforce Service Agent → Chess Coach**. Fallback Queue required → see gotcha.
- **Embedded Service deployment** `Chess_Coach_Web` (Site `0DMg8000001A30s`, ClientVersion WebV1).
- **Bootstrap snippet captured** (filled all remaining registry TODOs in
  `config/agent_deployments.yml`):
  - org id (15-char, as init() expects): `00Dg8000008l1Ac`
  - deployment_name: `Chess_Coach_Web`
  - site_url: `https://trailsignup-e8eb68b2222256.my.site.com/ESWChessCoachWeb1782171470213`
  - scrt2_url: `https://trailsignup-e8eb68b2222256.my.salesforce-scrt.com`
  - bootstrap.min.js: `<site_url>/assets/js/bootstrap.min.js`

### GOTCHA — Fallback Queue is REQUIRED and must support MessagingSession
- The Channel Routing step won't save without a Fallback Queue, and the picker only lists
  queues whose supported objects include **MessagingSession**. The org's lone queue
  (`Default_Queue_Agentforce_Contact_Center`, `00Gg8000003sCbxEAE`) wasn't enabled for it →
  didn't appear. Fix (CLI, no UI): create a `QueueSobject` row
  `QueueId=00Gg8000003sCbxEAE SobjectType=MessagingSession` (`03gg8000000aQVRAA2`). Then it
  shows in the picker. (Platform dedupes a double-insert, so one mapping remains.)

### User Verification — the REAL model (resolves the open item)
Setup node: **Setup → Service → Embedded Service → Enhanced Chat User Verification** (NOT the
channel Edit screen; not deployable metadata in this build). It uses a **JWKS** model, not a
raw-PEM-on-the-channel model:
- **JSON Web Key** = the public key. Form: Name, API Name, Active, Description, **Upload Files**
  (a file, no n/e fields). Uploaded `config/keys/identity_jwk.json` — a single JWK that embeds
  `kid: chess-identity-key-1` (generated from our public.pem via Ruby OpenSSL → base64url n/e).
  Created key **chess-identity-key-1**. (Also wrote `identity_jwks.json` keyset-wrapper +
  kept `.public.pem` as PEM fallbacks; the single JWK was accepted.)
- **JSON Web Keyset** = groups keys + carries the **JSON Web Key Issuer** (= our JWT `iss`).
  Form: Name, API Name, **JSON Web Key Issuer**, Description, **Type {Keys | Endpoint}**, **Keys**
  (attach). Created `Chess_Identity_Keyset`, Type **Keys** (attach uploaded key directly;
  "Endpoint" = remote JWKS URL we'd host), Issuer
  `https://chess-agent-jwt-95c105a581a5.herokuapp.com`, attached chess-identity-key-1.
- **⚠️ CLAIM-SET ANSWER:**
  - **`iss`** MUST byte-match the Keyset's JSON Web Key Issuer (no trailing slash). ✅ aligned
    with registry `issuer`.
  - **`kid`** (header) MUST match the JSON Web Key's embedded kid → resolves which key verifies.
    ✅ `chess-identity-key-1`.
  - **NO audience field exists** in the key/keyset config. Trust = **issuer + signature(kid)**,
    NOT `aud`. So `aud` is not validated against a configured Setup value here. Set registry
    `audience` to the org My Domain (`https://trailsignup-e8eb68b2222256.my.salesforce.com`) as
    a stable recipient; confirm empirically via session trace, adjust only if runtime rejects.
  - **sub→Contact mapping:** not a field on this UV config either. The verified `sub` surfaces
    on the **MessagingEndUser**; the coach reads `@MessagingEndUser.ContactId`. The sub→Contact
    resolution is the runtime's job (matched when the conversation is created), validated E2E.
- None of these UV entities are queryable via standard SObject API (JsonWebKey / keyset not
  exposed) — the Setup screen is ground truth.

### Test Contact (verified-greeting target) — seeded earlier
Jordan Player / player@example.com (`003g800000KXhnRAAT`), matches local dev Rails user.

### Registry now COMPLETE — zero TODOs in config/agent_deployments.yml.

**STILL in Phase 4b (Setup UI):** (a) allowed domains (localhost:3000 + Heroku);
(b) prechat parameter mapping for Chess_PGN/FEN/Turn/Move_Count/Status → conversation vars.
**THEN Phase 5:** Rails embed + agentforce_controller.js.

### GOTCHA — MIAW custom parameter String max length is capped at 255
Channel custom parameters (Messaging Settings → channel → Custom Parameters → New): Data Type
**String** forces a **Maximum Length** field whose ceiling is **255**. Implication: **Chess_PGN
can exceed 255 chars** for a long game. Decisions:
- All 5 params created String/255, names identical across Parameter Name / Parameter API Name /
  Channel Variable Name (= the agent's conversation var names): Chess_PGN, Chess_FEN, Chess_Turn,
  Chess_Move_Count, Chess_Status. Keeping names byte-identical avoids any client→channel→agent
  translation bug.
- **Phase 5 client must trim Chess_PGN to ≤255** before setHiddenPrechatFields. FEN is the
  position-of-record (always short, used by the coach for analysis), so trimming PGN narration
  doesn't hurt coaching. (TBD trim strategy: keep move tail vs. head — head preserves opening-
  name recognition; revisit in client code.)
- **Parameter Mappings** section maps params → *Flow* variables ("Flow Variable Name"). Our
  Chess Coach is an Agentforce Service Agent reading conversation variables directly, NOT via a
  flow — so Parameter Mappings likely NOT needed. Deferred; confirm via E2E session trace.

### Phase 4b COMPLETE
- 5 custom parameters created (String/255, names identical across all 3 fields): Chess_PGN,
  Chess_FEN, Chess_Turn, Chess_Move_Count, Chess_Status.
- **Parameter Mappings NOT created** — that section maps to a *Flow* ("Flow Variable Name").
  Routing goes directly to the Agentforce Service Agent (no flow), which reads the Channel
  Variable Name as its conversation variable. Confirm via E2E session trace; add mappings only
  if the agent doesn't see the values.
- CORS Allowed Origins added: https://chess-agent-jwt-95c105a581a5.herokuapp.com + http://localhost:3000.
- Registry config/agent_deployments.yml fully populated (zero TODOs).
→ Phase 4 (4a coach + 4b MIAW/User-Verification) DONE. Next: Phase 5 — Rails embed +
  agentforce_controller.js (setIdentityToken on ready, trimmed Chess_PGN in
  setHiddenPrechatFields, re-mint on expiry, clearSession on logout).

## 2026-06-22 — Phase 5: Rails embed + verification wiring DONE (tests green)

Built the client side that hands verified identity + live game context to the MIAW widget.

- **`app/javascript/controllers/agentforce_controller.js`** (new Stimulus controller). Lifecycle:
  - `connect()` injects the bootstrap script (idempotent across Turbo nav; guards on
    `window.embeddedservice_bootstrap` + a `#esw-bootstrap` script id).
  - `onEmbeddedMessagingReady` → `fetch('/identity_token?deployment=…')` →
    `userVerificationAPI.setIdentityToken({identityTokenType, identityToken})`, then seeds game
    context.
  - `onEmbeddedMessagingIdentityTokenExpired` → re-mint + setIdentityToken (30s window).
  - `endSession()` → `userVerificationAPI.clearSession({shouldEndSession:true})` on sign-out.
  - All Salesforce specifics come in as Stimulus *values* from the registry — nothing hardcoded
    (SOMA/MOMA stays a config change).
- **Layout** (`application.html.erb`): mounted `data-controller="agentforce"` **on `<body>`**
  (not a sibling div) so the sign-out button is inside the controller scope and
  `submit->agentforce#endSession` actually fires. Gated on `user_signed_in?`. Values fed by a
  new helper `current_agent_deployment` (= registry default for now).
- **`game_state.js`**: added `trimPgn()` — Chess_PGN capped at 255 (the channel-param ceiling),
  trimmed on a whole-move boundary + " …", keeping the OPENING (head) so the coach can still
  name the opening; FEN stays the position-of-record for analysis. Unit-sanity-checked via node.
- **Tests:** new `test/integration/agentforce_embed_test.rb` — verified user gets the controller
  + all registry-sourced data-* values + the endSession-wired sign-out form; anonymous visitor
  gets neither (no leaked config). Full suite **9 runs / 39 assertions / 0 failures**.
- **CSP note:** `config/initializers/content_security_policy.rb` is all-commented (Rails default,
  no CSP enforced) → embed's cross-origin script + SCRT2 websocket aren't blocked by our app.
  If CSP is enabled later, must allowlist the ESW site_url (script-src) + scrt2_url (connect-src).
  Hardening item, not a demo blocker.
→ Next: Phase 6 (deploy Rails to chess-agent-jwt Heroku + set IDENTITY_JWT_PRIVATE_KEY config
  var) so the allowed-domain/HTTPS path can be exercised, then E2E verification.

## 2026-06-22 — Phase 6: Rails deployed to Heroku (chess-agent-jwt) — LIVE & verified

App live at https://chess-agent-jwt-95c105a581a5.herokuapp.com (web + worker dynos up).

### Deploy config
- Buildpack pinned **heroku/ruby** (root has chess-mcp/package.json → must not autodetect Node).
- Config vars: RAILS_MASTER_KEY, IDENTITY_JWT_PRIVATE_KEY (multiline PEM via
  `heroku config:set VAR="$(cat ...pem)"` — round-trips, 28 lines), DEMO_USER_PASSWORD,
  RAILS_ENV/RACK_ENV=production. DATABASE_URL provided by heroku-postgresql:essential-0.
- production.rb: assume_ssl + force_ssl enabled (widget/UV require HTTPS; /up exempt).
- Procfile: web (puma) + worker (bin/jobs / solid_queue) + release (bin/release).

### GOTCHA — Rails 8 solid stack vs. single Heroku DB (worker crash)
- config/database.yml originally had 4 separate production DBs (primary + solid
  cache/queue/cable). Collapsed all onto one `url: DATABASE_URL`. BUT db:prepare dedupes by
  database, so it loaded only primary's schema.rb → solid_* tables never created → **worker
  dyno crashed: "relation solid_queue_recurring_tasks does not exist".**
- Fix: **bin/release** runs `db:prepare` then loads db/{queue,cache,cable}_schema.rb into the
  single DB, idempotently (skips when the marker table — solid_queue_jobs / solid_cache_entries
  / solid_cable_messages — already exists). Procfile release phase → bin/release. Worker then
  boots clean (Supervisor + Worker + Dispatcher + Scheduler all started).
- (One-off: loaded the 3 schemas manually on the first crashed release before bin/release
  existed; subsequent deploys are self-healing.)

### Demo user + live smoke test (the whole point)
- db/seeds.rb seeds player@example.com (idempotent; password from DEMO_USER_PASSWORD). Matches
  the Salesforce Contact Jordan Player → verified-greeting target. Seeded on prod (user id=1).
- Smoke test (curl, real session): / → 302 sign_in (anon), /up → 200, **/identity_token anon →
  302 sign_in (trust boundary holds — no token without a Devise session)**, http→https redirect
  works. Logged in as the demo user + fetched /identity_token → **real RS256 JWT minted live.**
- **Decoded live token — matches Setup exactly:** header {kid: chess-identity-key-1, alg:
  RS256}; payload iss=<heroku app> (byte-matches keyset issuer), sub=player@example.com
  (matches Contact), aud=<org My Domain>, exp-iat=300. iss+kid are the trust anchor → should
  verify against the registered keyset.
→ Phase 6 DONE. NEXT: E2E (sign in on live URL → open chat → confirm session trace shows
  VERIFIED + bound to Jordan Player's Contact + game context reached the agent; contrast anon)
  then Phase 7 docs. ⚠️ aud is the one value to confirm empirically in the E2E session trace.

## 2026-06-23 — E2E verification: deep debug. App side PROVEN; one platform-side binding unresolved

Ran live E2E as player@example.com on the Heroku app. Symptom: chat works but the agent
treats the user as anonymous (no name, no game context). Root cause is NOT our code — every
conversation binds as **Guest / UNAUTH** server-side despite a valid token. Full diagnosis:

### PROVEN CORRECT (ruled out as causes, with evidence)
- **JWT mint:** live Heroku-signed token fetched via curl; `JWT.decode` against
  config/keys/identity_jwt.public.pem → **signature VALID**. Claims correct: header
  {kid:chess-identity-key-1, alg:RS256}; payload iss=<heroku app, no trailing slash>,
  sub=player@example.com, aud=<org My Domain>, ttl 300s.
- **/identity_token endpoint:** 200 OK authenticated, 302→sign_in anonymous (trust boundary
  holds). Confirmed in browser Network tab.
- **Client apply:** console `userVerificationAPI.setIdentityToken(...)` → returns OK, no error.
  `userVerificationAPI` present (boot:object, uv:object, setter:function, prechat:function).
- **Keypair integrity:** cert pubkey md5 == public.pem md5 == JWK n/e — all the same public key.
- **Widget IS verification-aware:** after the x5c fix + republish, the **chat button only renders
  after a token is applied** (matches docs: "conversation button rendered after the API receives
  a valid identity token"). Before, a guest button always showed.

### THE x5c FIX (real, necessary — committed 3b79df1)
- **Salesforce JWK requires an `x5c` member** (kty/kid/alg/**x5c**), per the User Verification
  troubleshooting doc. Our original identity_jwk.json had only kty/kid/alg/use/n/e → the keyset
  silently couldn't validate tokens. Generated a self-signed X.509 cert FROM the existing private
  key (public key unchanged → existing tokens stay valid; 10yr validity; 2048-bit), rebuilt the
  JWK with x5c = strict-base64 DER of the cert. Re-uploaded key + recreated keyset in Setup.
  This is what made the widget start gating the button on a token (progress!).

### STILL UNRESOLVED — platform-side keyset↔conversation binding
- After x5c re-upload AND deployment republish AND clean incognito test, the MessagingEndUser is
  STILL `name='Guest'`, `ContactId=null`, MessagingPlatformKey `v2/iamessage/UNAUTH/NA/uid:<uuid>`.
  A verified user would read `AUTH/...uid:player@example.com` (per the overview doc).
- `MessagingChannel.Chess_Coach_Web.IsAuthenticated = false` and won't change via Setup:
  - **No "Add User Verification" option exists on the channel Edit form** (confirmed twice; that
    checkbox is Experience-Builder/Salesforce-site only — we're an EXTERNAL site).
  - No keyset/certificate/verification field on MessagingChannel (full describe done).
  - No queryable binding sobject (MessagingChannelUserVerification etc. all absent).
- Doc gap: `service.miaw_token_based_user_verification_setup.htm` (the canonical "Set Up
  Token-Based User Verification" steps) will NOT render via the doc tooling (persistent shell/
  CSS-error) — couldn't get the authoritative external-site channel-binding step.
- Did NOT blind-write IsAuthenticated=true (shared-org config; auto-mode classifier correctly
  blocked it, and it likely isn't the real mechanism anyway).

### CONCLUSION / HANDOFF
Everything in this repo's control is correct and proven. The remaining failure is a Salesforce
**platform-side association between the JSON Web Keyset and the messaging channel/deployment**
that has no exposed config surface we could find and no renderable setup doc. This is a
"confirm with Salesforce (MIAW User Verification is Beta) / read the official setup article in a
browser" item, NOT an app bug.
**To resume:** open `service.miaw_token_based_user_verification_setup.htm` in a browser and find
the step that ties the keyset to the channel (or the external-site activation step). The success
check is one query: MessagingEndUser.ContactId populated + platformKey contains `AUTH/...`.

## 2026-06-23 — PAUSED: waiting on PM to enable org-level User Verification preference

Root cause narrowed (with Slackbot/internal help). The UNAUTH/Guest binding is almost certainly
a **missing org-level enablement**, not an app or per-channel config issue.

- **Suspected toggle:** `EmbeddedMessagingUserVerification` (org preference). Not reachable via
  my tooling — `OrgPreferenceSettings` isn't a queryable SObject, and `Settings:LiveMessage`
  metadata only exposes `enableLiveMessage=true` (no verification flag). So it's a Setup/support-
  gated org pref.
- **Slackbot confirmed:** Enhanced Chat **V2 is NOT required** for token-based User Verification
  on an external site — staying on **V1** (no deployment migration, no snippet/URL churn).
- **Action in flight:** user has a request out to the **PM to enable** the org preference for
  org `00Dg8000008l1Ac` (MIAW User Verification is Beta).

**When it's enabled, resume here (everything else is already in place & proven):**
1. Re-run the success check — no app changes expected:
   `SELECT Name, ContactId, MessagingPlatformKey FROM MessagingEndUser ORDER BY CreatedDate DESC LIMIT 3`
   (export SF_AUTOUPDATE_DISABLE=true for clean JSON). SUCCESS = ContactId populated +
   MessagingPlatformKey contains `AUTH/...` (not `UNAUTH`). Also check
   `MessagingChannel.Chess_Coach_Web.IsAuthenticated` flipped to true.
2. Clean test: incognito → app → sign in player@example.com / ChessCoach2026! → hard refresh →
   chat button appears → send a message. Coach should greet "Jordan" + reference the game.
3. If still UNAUTH after the pref is on: re-confirm keyset issuer byte-match + that the x5c key
   is the active one; then back to the PM/support.

**Proven-working inventory (unchanged):** Heroku app live; JWT mint + signature + claims correct;
x5c JWK uploaded; keyset `Chess_Identity_Keyset` (issuer = heroku app URL, no trailing slash);
widget verification-aware (button gates on token). Only the org pref remains.

**Remaining project work after verification confirms:** Phase 7 docs — `docs/architecture-and-build.md`
(Mermaid auth-flow + SOMA/MOMA + gotchas incl. the x5c lesson) + separate `docs/demo-script.md`.

## 2026-06-23 — Agent fully operational: engine-grounded coaching live (Apex → REST facade)

Decoupled from the (still-blocked) verification work: got the coach calling real Stockfish for
any visitor — verified or guest. The native mcpTool:// binding is STILL blocked (McpServerDefinition
exists at API v64+ but exposes only DeveloperName/Language/MasterLabel/Description as createable;
0 tool records persist — same Beta wall). So we reached the same MCP server via supported tech.

### chess-mcp: added a plain JSON REST facade (committed + deployed to chess-mcp-coach)
- Refactored the 4 tool bodies into `src/tools.js` (single implementation). Both transports are
  thin wrappers: `src/server.js` (MCP) and new `src/rest.js` (REST). No logic duplication.
- New endpoints (POST JSON): /api/analyze, /api/best-move, /api/explain-move, /api/name-opening.
  Illegal input → 400. Tests: new rest.test.mjs + existing MCP tests both green (10/10).
- Deployed via `git subtree push --prefix chess-mcp heroku-mcp main` — **needs interactive
  heroku auth** (token/netrc push failed non-interactively; user ran it). Live + verified:
  /api/analyze returns real eval/PV, /api/name-opening → "Ruy López (Spanish Opening)".

### Salesforce: 4 Apex invocable actions → ChessCoachApi Named Credential → REST facade
- `ChessCoachClient` (shared HTTP callout) + 4 invocable classes (Apex allows ONE
  @InvocableMethod per class, so they're split): ChessCoachAnalyzePosition / ChessCoachBestMove /
  ChessCoachJudgeMove / ChessCoachNameOpening. Test class ChessCoachAnalysisTest (HttpCalloutMock,
  5 passing).
- New Named Credential **ChessCoachApi** → base URL `https://chess-mcp-coach-...herokuapp.com`
  (reuses the existing ChessMCP ExternalCredential / NoAuthentication). Left the original ChessMCP
  NC (→/mcp) untouched for the future native binding.
- Agent: replaced the 4 commented mcpTool:// placeholders with live `apex://` action defs
  (analyze_position/get_best_move/judge_move/identify_opening) + reasoning references. Instructions
  now say to ground claims in the engine and use the FEN the player gives.

### GOTCHAS hit + fixed (all real, all in the new Chess_Coach_Actions permission set)
1. **Apex annotation:** `description='...engine''s...'` (doubled-quote apostrophe) → "Unexpected
   token". Removed the apostrophes.
2. **One @InvocableMethod per class** — can't put 4 in one class. Split into 4 classes.
3. **Agent output param type:** judge_move's evalSwingCp as Apex `Decimal` → preview start failed
   ("update data type to object / lightning__numberType"). Simplest fix: return it as String
   (coach just relays it). 
4. **Rigid input binding:** `with fen = @variables.Chess_FEN` forced fen="" whenever Chess_FEN was
   blank (true in preview — no MessagingSession). Trace showed FunctionStep input {"fen":""} →
   REQUIRED_FIELD_MISSING. Fix: leave inputs UNBOUND so the planner fills them from context.
5. **Permissions (the big one — trace `runtime_withheld_actions` with filter_reasons):**
   - `NO_USER_ACCESS` on all Apex classes (incl. the previously-shipped get_player_name, which
     had simply never been invoked) → `classAccesses` for all five.
   - CalloutException "couldn't access credential ChessMCP" → `externalCredentialPrincipalAccesses`
     for principal **ChessMCP-MCPAuthentication** (format: `<ExternalCred>-<ParameterGroup>`).
   - "no read on User External Credential object" → `objectPermissions` read on
     **UserExternalCredential**.
   Permission set assigned to the Einstein Agent User chesscoach.agent@chess-agent.demo.
- **Diagnosis method:** session trace at `.sfdx/agents/Chess_Coach/sessions/<id>/traces/*.json` —
  EnabledToolsStep (`runtime_withheld_actions`) and FunctionStep (`input` + `errors`) were the
  ground truth that pinpointed each gap. The user-facing "technical issue" message was useless;
  the trace named the exact cause every time.

### VERIFIED in live preview (--use-live-actions) + PUBLISHED + ACTIVATED
- "best move for Black + eval" (Ruy López FEN) → **a6, +0.32, real PV** (engine, not LLM).
- "was 2...f6 good?" → correctly judged risky (Qh5/d4 ideas).
- "what opening is e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6?" → Ruy López.
- The coach is now fully operational for ANY visitor (guest or verified). Verified-identity
  greeting-by-name still pends the org User-Verification preference (PM request out) — independent.

## TODO — migrate engine coaching from Apex shim back to native MCP (when Beta unblocks)

The Apex→REST-facade path is a **deliberate workaround** for the Beta MCP wall, NOT the desired
end state. Once Salesforce's MCP support reveals the endpoint/tool fields and persists
McpServerToolDefinition records (so `mcpTool://` targets resolve), migrate to native MCP and tear
down the shim:

**Done-when (native MCP works OOTB):**
- [ ] Re-verify: `McpServerDefinition` createable fields include endpoint/NamedCredential, and
      registering chess-mcp populates `McpServerToolDefinition` records with target IDs
      (check via raw Tooling REST — `sf api request rest /tooling/query` is ground truth; the
      CLI SOQL wrapper has given phantom counts before).
- [ ] Re-point the agent's 4 actions to `mcpTool://ChessMCP/<tool>` (analyze_fen / best_move /
      explain_move / name_opening) instead of the `apex://ChessCoach*` targets, in
      `Chess_Coach.agent` (reasoning refs + action defs). The MCP server already exposes these
      tools over Streamable HTTP at /mcp via the ChessMCP NamedCredential — no server change needed.
- [ ] Validate (`sf agent validate`) + live-preview (`--use-live-actions`) the native tools, then
      publish + activate.

**Then remove the now-redundant shim:**
- [ ] Delete Apex: ChessCoachAnalyzePosition / ChessCoachBestMove / ChessCoachJudgeMove /
      ChessCoachNameOpening / ChessCoachClient (+ their tests in ChessCoachAnalysisTest).
      (Keep ChessCoachGetPlayerName — that's the name-greeting action, unrelated to MCP.)
- [ ] Trim Chess_Coach_Actions permission set: drop the 4 analysis classAccesses + the
      externalCredentialPrincipalAccesses (ChessMCP-MCPAuthentication) + the UserExternalCredential
      objectPermission IF nothing else needs them. Keep ChessCoachGetPlayerName class access.
- [ ] Decide on the REST facade: the chess-mcp `/api/*` endpoints + `src/rest.js` can stay (handy
      for testing / other clients) or be removed. The shared `src/tools.js` STAYS either way — the
      native MCP path uses it too. The ChessCoachApi NamedCredential can be deleted with the Apex.
- [ ] Update docs/agentforce-user-verification-guide.md + architecture doc to reflect native MCP.

**Why both exist meanwhile:** the chess-mcp server already serves BOTH transports off the same
`src/tools.js` — MCP (/mcp, for the future native binding) and REST (/api/*, for today's Apex
shim). So flipping to native is purely a Salesforce-side rewire; the server is already ready.

## 2026-06-23 — Game context: prechat fields SENT correctly but don't reach the agent variable

E2E live: coach gives real engine coaching but keeps asking for the FEN — it doesn't see the
on-screen game. Traced the whole path; the break is the MIAW-prechat-field → agent-variable bind.

### What's PROVEN working (ruled out)
- **Client sends correct, current data:** console-hooked `setHiddenPrechatFields` — fires on every
  move with a real live `Chess_FEN` (e.g. r1bqkbnr/pp1p1ppp/2n1p3/...) + Turn/Move_Count/Status.
- **Re-seed timing fixed:** game_state dispatches `chess:state-changed`; the agentforce controller
  re-seeds on every move (was only seeding once at page-load = starting position). Deployed v9.
- **Deployment hidden-prechat fields fixed:** all 5 Chess_* were in "Available" only — moved to
  "Selected" + republished. Confirmed in the retrieved EmbeddedServiceConfig (5 formFields,
  isHidden=true).

### The unresolved break: prechat field → conversation variable
- Agent's Chess_* vars were `mutable string = ""` with NO source → never populated; stayed default.
- Tried `linked` + `source: @context.Chess_FEN` → **compiler rejects**: "source must reference
  @MessagingSession / @MessagingEndUser / @VoiceCall."
- Tried `source: @MessagingSession.Chess_FEN` → **validates but FAILS PUBLISH**: "you don't have
  access to field MessagingSession.Chess_PGN." And `describe MessagingSession` confirms **no
  Chess_* custom fields exist** (43 fields, 0 custom) — the channel Custom Parameters do NOT
  materialize as MessagingSession fields.
- No queryable object for the params (ConversationChannelParameter / ConversationVariable / etc.
  all INVALID_TYPE). The setup doc (service.miaw_custom_parameters.htm etc.) won't render via tooling.
- **Conclusion:** the supported mechanism to bind a MIAW hidden prechat field / channel custom
  parameter to an Agentforce conversation variable is unknown and not discoverable from here.
  Reverted the vars to `mutable` so the agent PUBLISHES + ACTIVATES (engine actions unaffected).
- **Decision:** ask Slackbot (internal docs) for the authoritative binding. Engine coaching works
  fully meanwhile; the player just supplies the FEN in chat.

### Minor known bug (fix later)
- trimPgn is capturing PGN *headers*: Chess_PGN came through as `[SetUp "1"]\n[FEN ...]\n3. f4 e6`
  instead of clean SAN. The chess.js .pgn() output includes headers; strip them in game_state.

## 2026-06-23 — RESOLVED (mechanism): prechat→agent is a 5-layer pipeline, not a direct bind

Slackbot (internal docs) gave the authoritative answer. There is **no direct** prechat-field →
agent-variable binding. The supported path writes prechat values into **MessagingSession custom
fields** via an Omni-Flow, and the agent reads `@MessagingSession.<field>__c`. Full guide written:
**docs/miaw-prechat-to-agent-guide.md** (referenced from CLAUDE.md).

Pipeline: client setHiddenPrechatFields → [1] Messaging Settings Custom Parameter → [2] Parameter
Mapping (param→Omni-Flow input var) → [3] **Omni-Flow Update Records writes flow var →
MessagingSession.X__c** (the almost-always-missing step; Splunk tell: "Get Flow Input Parameters
for Channel. Returning empty map.") → [4] Agent Context → Messaging Session → Edit Included Fields
→ select X__c → [5] agent reads @MessagingSession.X__c.

Why our attempts failed, now explained: `@MessagingSession.Chess_FEN` was the RIGHT source syntax
— it failed publish only because **the custom field didn't exist** (we never created MessagingSession
custom fields, and there was no Omni-Flow writing to them; the channel routes directly to the agent,
RoutingType=None). `@context.*` is simply not a thing for this.

Prereqs (no Beta flag): Einstein GenAI on; field in BOTH Custom Parameters AND deployment Hidden
Pre-Chat Fields; agent user has Agentforce Service Agent Object Access + Configuration perm sets +
FLS on the new fields; MessagingSession custom fields created.

### NEXT (build the pipeline — checklist in the guide)
1. Create MessagingSession custom fields Chess_FEN__c / Chess_PGN__c / Chess_Turn__c /
   Chess_Move_Count__c / Chess_Status__c.
2. Build the Omni-Channel routing Flow: Parameter Mappings + Update Records → MessagingSession.*__c.
   (This is the main new build — channel currently has no routing flow.)
3. Agent Context: include the 5 fields.
4. .agent: Chess_* → linked, source @MessagingSession.Chess_*__c. Publish + activate.
5. FLS read on the 5 fields → Chess_Coach_Actions perm set. E2E test.

## 2026-06-23 — Prechat pipeline: custom fields built; routing question open

Built the foundation, then hit a routing wrinkle worth confirming before building the flow.

- ✅ **5 MessagingSession custom fields deployed:** Chess_FEN__c (120), Chess_PGN__c (255),
  Chess_Turn__c (10), Chess_Move_Count__c (10), Chess_Status__c (20). Under
  objects/MessagingSession/fields/. This is the slot the agent reads + why
  @MessagingSession.Chess_FEN failed publish before (no field existed).
- ⚠️ **Routing wrinkle:** the Slackbot pipeline (Parameter Mapping → Omni-Flow Update Records →
  MessagingSession field) assumes an **Omni-Channel routing flow**. But our channel routes
  **directly to the Agentforce agent** — `MessagingChannel.Chess_Coach_Web.RoutingType = None`
  (picklist options are OmniQueue / OmniSkills; neither set). There is no Omni-Flow in the path.
  Introducing one may require re-pointing the channel's routing, which could disrupt the working
  direct-to-agent connection.
- **Decision:** before authoring a routing flow blind, ask Slackbot where the
  Update-Records→MessagingSession step lives for a **direct-to-agent (no Omni queue/skills)**
  channel — is a routing-flow switch required, or is there an inbound/routing hook for
  agent-routed channels? Question drafted; awaiting answer.

## 2026-06-23 — Slackbot resolved routing; agent-side binding now PUBLISHES

Slackbot confirmed: "direct-to-agent" IS an Omni-Flow — there's no path that bypasses Omni-Channel.
Switching RoutingType None → Omni-Flow PRESERVES direct-to-agent (the flow's Route Work→Bot element
== the old shortcut). Parameter Mappings are inert until the flow exists, then auto-activate. Full
recipe in docs/miaw-prechat-to-agent-guide.md (minimal flow: Update Records → MS fields, then Route
Work → Bot).

Did everything authorable as metadata:
- ✅ FLS read on the 5 Chess_*__c fields → Chess_Coach_Actions perm set (deployed).
- ✅ Agent vars flipped to `linked` + `source: @MessagingSession.Chess_*__c` — **PUBLISHES +
  ACTIVATES now** (the earlier publish failure was purely the missing field; source syntax was
  right all along). Until the flow writes the fields they read empty (agent asks for FEN — harmless).

REMAINING (all Setup UI — see guide checklist; metadata-authoring a routing flow blind is too risky):
1. Parameter Mappings: each Custom Parameter Chess_* → Flow Variable Chess_* (case-exact). [we
   deferred these earlier — Slackbot's checklist assumed done, but they're NOT in our org yet]
2. Omni-Flow (Flow Builder): 5 Text input vars → Update Records on MessagingSession ($Record.Id)
   writing Chess_*__c → Route Work (Bot = Chess Coach). Activate.
3. Channel Routing Type → Omni-Flow, select the flow.
4. Agent Builder → Context → Messaging Session → Edit Included Fields → select the 5 Chess_*__c.

## 2026-06-23 — Omni routing flow BUILT as metadata (not UI); 3 channel-config steps remain

Pushed past "this needs the UI" — most of it was metadata-authorable after all:
- ✅ **Chess_Coach_Routing** RoutingFlow authored + deployed **Active** (activeVersion
  301g800000PbgFMAAZ). Structure: recordId + 5 Text input vars → **Update Records** on
  MessagingSession (filter Id=recordId) writing Chess_*__c → **routeWork** action (routingType=Bot,
  serviceChannelId=0N9g8000000ytHlCAI [sfdc_livemessage], botId=0Xxg8000000mw8DCAQ [Chess Coach]).
- **Method:** iterated with `sf project deploy start --dry-run` to learn requirements (it taught
  me: needs a `recordId` Text input var; active deploy additionally requires serviceChannelId +
  labels, not just devName). routeWork is the right action; forwardToBotOrAgent is for SMS/WhatsApp
  outbound (red herring). Real IDs pulled from ServiceChannel + BotDefinition queries.
- ✅ MessagingSession custom fields + FLS + agent var bindings (@MessagingSession.Chess_*__c,
  publishes) — all done earlier.

**REMAINING — 3 channel-config steps that ARE UI-only (element names not safely guessable; picker
handles IDs):**
1. Channel Routing Type → **Omni-Flow** → select Chess_Coach_Routing (replaces direct-to-agent;
   sessionHandlerType currently AgentforceServiceAgent). Messaging Settings → channel → Edit.
2. **Parameter Mappings** (×5): Custom Parameter Chess_* → Flow Variable Chess_* (case-exact).
   These activate the param→flow-input injection; inert until the flow is attached.
3. Agent Builder → Context → Messaging Session → **Edit Included Fields** → select 5 Chess_*__c.
Then E2E: mid-game chat → coach knows the position without being asked.

## 2026-06-23 — Omni-Flow routeWork does NOT assign the Agentforce Service Agent (broke chat)

Switched channel to the Chess_Coach_Routing Omni-Flow → coach stopped entering the chat. Root cause
found via routing records, NOT guessing:
- New sessions (with the flow): **Status=Waiting, Owner=Default Queue Agentforce Contact Center**.
- **PendingServiceRouting.RoutingType = QueueBased** for those sessions.
- The OLD working (direct-to-agent) session: Owner = **Automated Process** (that's a correctly
  agent-routed session).
→ So `routeWork` fell through to **queue-based** routing (fallback queue, no human → waits forever),
  regardless of routingType. Tried `routingType=Bot`+botId (legacy Einstein Bot) AND
  `routingType=Copilot`+copilotId (BotDefinition.Type=ExternalCopilot). BOTH deploy clean but BOTH
  produce QueueBased PSR — neither assigns the ASA/Copilot.
- routeWork inputs include botId / copilotId / agentforceEmployeeAgentId / externalConversationBotId
  / digitalWorkerId — but the right combination/routingType for an Agentforce SERVICE agent
  (ExternalCopilot, Chess_Coach 0Xxg8000000mw8DCAQ) is unknown and not guessable safely.
- **ACTION: reverting channel Routing Type → Agentforce Service Agent (direct) to restore the coach.**
  The Omni-Flow (Chess_Coach_Routing v2, Active) stays deployed but UNATTACHED until we know the
  correct routeWork config.
- **ASK SLACKBOT:** in an Omni-Channel routing flow, what is the exact `routeWork` (or other action)
  config to assign an **Agentforce Service Agent** (BotDefinition.Type=ExternalCopilot)? Which
  id param + routingType value? Our attempts (Bot/botId, Copilot/copilotId) both produced
  PendingServiceRouting.RoutingType=QueueBased and the session sat in the fallback queue.

## 2026-06-23 — Routing FIXED (stock flow pattern) + the silent empty-parameter-mapping gotcha

### Routing solved by cloning the stock Agentforce flow
My hand-authored routeWork (routingType Bot, then Copilot) always fell through to QueueBased — WRONG.
The org ships a stock Omni flow **"Route Conversations to Agentforce Service Agents"**
(`AiCopilot__LanguageChat`) whose structure is exactly right: Start → Update Records (writes a MS
field) → **Route Work** → End. Its Route Work uses **Route To = "Agentforce Service Agent"** (a
dedicated dropdown picking the agent directly) — NOT routingType Bot/Copilot. That stock flow's
internals aren't retrievable/queryable (managed `AiCopilot__` namespace), so we couldn't copy its
routeWork params into metadata. Solution: **"Save As New Flow"** in Flow Builder to clone it →
`Chess_Coach_Routing_v2`, then added our 5 Chess_*__c field-writes to its Update Records + 5 Text
input vars. Channel now: `sessionHandlerType=Flow`, `sessionHandlerFlow=Chess_Coach_Routing_v2`.
Result: new session **Status=Active, Owner=Automated Process** = correctly agent-routed (vs. the
broken attempts: Waiting / fallback queue). Lesson: **clone the stock ASA routing flow; don't hand-
author the Route Work element.**

### GOTCHA — MessagingSession custom fields invisible without FLS (looked like they didn't deploy)
The 5 Chess_*__c fields deployed fine (CustomField records exist, redeploy says created:False) but
`sf sobject describe MessagingSession` showed **0 Chess fields**, and they didn't appear in the Flow
Builder field picker. Cause: **field-level security** — the fields were invisible to the running/
admin user because only the *agent* user had FLS (via Chess_Coach_Actions). Fix: assign
Chess_Coach_Actions to the admin user too (`sf org assign permset --name Chess_Coach_Actions`).
Then describe + the Flow picker showed all 5. **A deployed custom field with no FLS for your user is
invisible everywhere (describe AND Flow Builder) — looks like it never deployed.**

### GOTCHA — Parameter Mappings show as "existing" in the UI but are SILENTLY UNHOOKED
This one had no UI indication. The channel's Custom Parameters (Chess_FEN etc.) existed and the
Parameter Mappings *appeared present* in Setup, but the retrieved MessagingChannel metadata showed
every mapping's link was EMPTY:
    <actionParameterMappings>
    </actionParameterMappings>            ← blank! the param→flow-variable binding was never set
    <externalParameterName>Chess_FEN</externalParameterName>
    <name>Chess_FEN</name>
So the flow's input vars arrived empty → Update Records wrote nulls → Chess_FEN__c stayed None even
though routing + flow + fields were all correct. **The UI gave no sign the mapping was unhooked.**
Only the metadata retrieve revealed it. Re-creating the mappings (now that the v2 flow exists to bind
to) populated them: `<actionParameterMappings><actionParameterName>Chess_FEN</actionParameterName>...`.
LESSON: to verify Parameter Mappings are actually bound, **retrieve the MessagingChannel metadata and
check `<actionParameterMappings>` is non-empty** — don't trust the Setup UI's appearance. Likely the
mappings need an ACTIVE routing flow to bind against; created before the flow existed = silently blank.

## 2026-06-23 — Flow PROVEN correct via Debug; bug isolated to Parameter-Mapping→flow-input hop

Flow Debug (recordId=real session, Chess_FEN=DEBUG_TEST_FEN) → Update Records wrote
Chess_FEN__c=DEBUG_TEST_FEN, "Transaction Committed", and a follow-up query CONFIRMED the value
persisted on the session. So the entire flow + field + FLS (editable now) + Update Records + filter
(Id=recordId) chain WORKS when given an input value.

Therefore the ONLY remaining break: at real runtime the flow's `Chess_FEN` input variable arrives
**null** (live sessions write null; Debug with a manual value writes fine). I.e. the **Parameter
Mapping is not delivering the hidden-prechat value into the flow input variable.**

State of the mapping (metadata): non-empty but minimal —
    <actionParameterMappings>
        <actionParameterName>Chess_FEN</actionParameterName>
    </actionParameterMappings>
    <externalParameterName>Chess_FEN</externalParameterName>
    <name>Chess_FEN</name>
It names the target var but carries NO flow reference. Unclear if that's sufficient.

Two candidates for the dead hop (need to confirm which):
  (a) client not sending the fields on the live conversation post routing-change (earlier a console
      hook proved setHiddenPrechatFields DID send a real FEN — but re-verify after the republish), OR
  (b) SCRT2 not passing the custom parameter into the flow input despite the mapping.

NOTE the Route Work debug showed routingType=Copilot + copilotId=Chess Coach AND queueId set, yet it
routes correctly now (Active/Automated Process) — leave routing alone, it works.

### Status: routing + flow + fields all proven working. ONE hop left (param-mapping→flow-input).
ASK SLACKBOT: with a MIAW Custom Parameter + Parameter Mapping whose metadata shows
`<actionParameterMappings><actionParameterName>Chess_FEN</actionParameterName></actionParameterMappings>`
(no flow ref) and an active Omni routing flow with a matching `Chess_FEN` Text input var, the flow
input still arrives null at runtime (proven via Debug that the flow writes correctly when given a
value). What makes the hidden-prechat Custom Parameter actually populate the flow's input variable?
Is a flow reference required on the mapping? Does the client need to send it a specific way?

## 2026-06-23 — RESOLVED: game context live end-to-end. Root cause = Pre-Chat inactive on the ESD.

The dead hop was NOT the Parameter Mapping (Slackbot's `<flowVariableName>` theory was wrong — see
below). The actual cause was upstream of everything we'd been debugging: **Pre-Chat was not ACTIVE on
the Embedded Service Deployment.** With pre-chat inactive, SCRT2 silently DROPS all hidden prechat
fields at the front door — the client's `setHiddenPrechatFields(...)` values are accepted by the
widget but never forwarded into the conversation, so the flow's input vars arrive null. Every
downstream layer (param mappings, flow input vars, Update Records, FLS, agent linked vars) was correct
the whole time; we just couldn't see any value flow because nothing was let through.

Fix: Setup → Embedded Service Deployment → enable/activate **Pre-Chat**, confirm the 5 `Chess_*`
fields are in **Hidden Pre-Chat Fields → Selected**, then **Publish the deployment** (ESD changes are
invisible to the live site until republished), then hard-refresh (cached bootstrap). Verified live: the
coach reasons about the actual on-screen FEN without being asked for one.

DEAD END (Slackbot was wrong): Slackbot claimed the mapping needed a `<flowVariableName>` child element
inside `<actionParameterMappings>`. Deploy FAILED — `Element flowVariableName invalid at this location
in type MessagingChannelActionParameterMapping`. The schema allows ONLY `<actionParameterName>`. The
binding is **by matching name**: `<actionParameterName>Chess_FEN</actionParameterName>` binds to the
flow input variable literally named `Chess_FEN`. There is no separate flow-variable element. Reverted.

Bonus: the MessagingChannel + Chess_Coach_Routing_v2 flow now retrieve cleanly (the earlier status-1
retrieve failed only because the active flow didn't exist yet) — both vendored into source now.

## 2026-06-24 — Native MCP actions CONFIRMED firing (the open question, closed)

Built a dedicated experiment agent `Chess_Coach_MCP` — a full clone of the production Chess Coach
(all MIAW/game vars, before_reasoning name lookup, both helper subagents, the `get_player_name` Apex
action) with the 4 engine actions deliberately omitted, so the only variable under test is the native
`mcpTool://` wiring. Authored everything *except* the MCP actions in source; added the 4 ChessMCP
tools (`analyze_fen`, `best_move`, `name_opening`, `explain_move`) **in the builder**, then Saved →
Committed → Activated.

Retrieved the activated planner bundle and decoded its base64 `agentScript/*.agent`. **All 4 bindings
confirmed**, generalizing the pattern we'd only seen for `analyze_fen`:

  analyze_fen  → target: mcpTool://mcptoolx5fx5fanalyzex5ffen   source: ac87fbaba830738a5a8426570d3b2998d
  best_move    → target: mcpTool://mcptoolx5fx5fbestx5fmove     source: a01f925b1425e355c808d5546c4a23d29
  name_opening → target: mcpTool://mcptoolx5fx5fnamex5fopening  source: a133e570ebcdc3216a2006b763f58057f
  explain_move → target: mcpTool://mcptoolx5fx5fexplainx5fmove  source: ae85c69cebea2380aa530fdb350022cdb

The `_`→`x5f` hex escaping + `mcptool__` prefix hold for every tool. The risky array input bound fine:
`name_opening`'s `moves` array became `list[object]` + `complex_data_type_name: "lightning__textType"`.
Every input carries the weak `label: "string"` (MCP schema names params generically — server-side fix).

THE KEY FINDING — activation is what makes MCP fire. The authoring-bundle preview never invoked MCP
(that's why the earlier in-place migration looked broken). But previewing the **activated** agent with
`--api-name Chess_Coach_MCP` and asking for an engine analysis returned a real Stockfish eval
(`+0.17 for White`). Proof it went native, not via the Apex shim: tailing the MCP server's own Heroku
logs (`chess-mcp-coach`), the test sends landed on **`POST /mcp`** (full Streamable-HTTP handshake:
initialize → 202 notify → tools/list → GET SSE → DELETE, then the tool call) from Salesforce egress
IPs `10.77.x.x` — NOT on the `/api/analyze`/`/api/best-move` REST paths the Apex shim uses. So: MCP
validates + publishes but won't run in authoring-bundle preview; once activated it performs the real
MCP protocol exchange against the server.

Production `Chess_Coach` remains untouched on its 5 Apex actions (reverted clean earlier). Findings
promoted to the skill ref: ~/.claude/skills/developing-agentforce/references/mcp-tool-actions.md
(Last verified bumped to 2026-06-24; analyze_fen-only caveats removed; array-input + activation
callouts added).

OPEN / NEXT: decide path forward. Native MCP works, so the question is optimization, not feasibility —
(1) fix the MCP server tool schemas to emit real param names (kill the `label: "string"`), (2) decide
whether to migrate the production Coach off the Apex shim onto MCP (trade-off: less code/maintenance
vs. org-coupled `source:`/`target:` ids that hurt SOMA/MOMA portability — see skill ref §6), (3) the
`source:` hashes are per-org so a reusable asset must regenerate the MCP action block per org.

## 2026-06-24 — MCP server: per-param titles (label experiment) + filled depth descriptions

Re-decoding Chess_Coach_MCP showed the platform stamps `label: "string"` on EVERY native MCP action
input — including `depth` (integer) and `moves` (array). So the label is NOT derived from the param
name or type (my earlier "generic naming" guess was wrong — the live tools/list schema is well-formed:
real names, types, descriptions). It's a placeholder the platform inserts when a schema property has no
JSON-schema `title`.

Server-side experiment: added `.meta({ title, description })` to all params across the 4 tools (zod v4
folds .describe() into .meta), so the emitted schema now carries a real `title`. Verified through the
MCP SDK's own zod→JSON-schema converter (`toJsonSchemaCompat`) that `.meta({title})` becomes a property
`title`, booted locally to confirm tools/list emits them, then deployed (`git subtree push --prefix
chess-mcp heroku-mcp main` — went through first try, user was logged in; Released v6). Live tools/list
now shows title+desc on every param. Tests 10/10 green.

Also filled the two `depth` params that had NO description (best_move, explain_move) — real planner
value, independent of the label question.

OPEN (needs builder round-trip): does the platform now surface the `title` as the action `label:`
instead of "string"? To find out: re-add a tool to the coach subagent in the builder, Save → Commit →
Activate, then retrieve the new planner version, decode its agentScript, and check the `label:` field.
The MCP server caches nothing, but Agentforce derives the GenAiFunction inputs at action-add time — so
the tool must be re-added (or the action refreshed) in the builder to pick up the new schema.

## 2026-06-24 — label experiment RESOLVED: schema `title` → action `label:` (confirmed)

The `.meta({title})` experiment is proven. After deploying the titled schema (v6) and reactivating the
agent, the decoded Chess_Coach_MCP **v4** agentScript shows every input label flipped from the `"string"`
placeholder to the real title:

  fen   → label: "FEN Position"     depth → label: "Search Depth"
  move  → label: "Move Played"      moves → label: "Moves (SAN)"

So: the Agentforce MCP-action input `label:` is driven by the tool schema's per-property JSON-schema
`title`; with no title the platform stamps the literal `"string"`. Fix = emit `title` server-side
(zod v4: `.meta({ title, description })`).

GOTCHA discovered along the way (now in skill ref §5): the tool catalog is CACHED at registration time.
Editing the MCP Server registration Details and re-saving does NOT re-pull tools/list — the schema stayed
2 days stale (empty depth descriptions, no titles) through a builder re-add (that produced v3, still
`label: "string"`). The fix: Setup → Agentforce Registry → MCP Servers → ChessMCP → **Tools** tab, where
each tool showed a yellow **⚠ Out of Sync** badge; syncing that re-fetched the live schema (titles +
descriptions appeared). THEN re-add the action in the builder → Save → Commit → Activate (v4) → titles
land in the decoded `label:`. The builder's Inputs screen also now shows "FEN Position" / "Search Depth"
as the input names instead of bare types.

Net for the project: Chess_Coach_MCP is the clean reference (v4, all 4 native MCP tools, real labels +
descriptions). Production Chess_Coach untouched on Apex. Skill ref mcp-tool-actions.md §5 rewritten from
"cosmetic placeholder, probably not fixable" → "confirmed title-driven, here's the fix + the re-sync
gotcha". chess-mcp server change committed (46a7281) + deployed (Released v6).

## 2026-06-24 — Chess_Coach_MCP v4 behavioral pass (performative ✅)

Ran a 4-utterance behavioral test against the activated v4 (native MCP), one per tool, each with an
independently-checkable position. All grounded in real Stockfish over /mcp (log service= 120–500ms):
  - analyze_fen : Italian Game → "+0.17 White", recommends Nf6. Correct.
  - best_move   : mate-in-1 → Qxf7#. Found the checkmate.
  - explain_move: ...Qg5 after 1.e4 e5 2.Nf3 → BLUNDER, +7.4 swing, best was Nc6. Correct (Nxg5 wins Q).
  - name_opening: e4 e5 Nf3 Nc6 Bb5 → Ruy López / Spanish. Correct.

Best behavior observed: fed a malformed FEN (knight already off g8, so Nf6 illegal), the agent called
the engine, got "illegal/unparseable", and ASKED FOR CLARIFICATION rather than fabricating a verdict —
exactly the "never invent evaluations" grounding we want. (That first explain_move test was a bad
fixture on my end; re-ran with a valid blunder position → correct.)

Minor: in the mate test the agent's prose mislabeled Qxf7# as "Fool's Mate" (it's the Scholar's-mate
pattern). LLM terminology slip only — the engine move was right. Not worth chasing unless tightening
opening/pattern naming becomes a goal.

Conclusion: native-MCP Chess_Coach_MCP is functionally on par with the Apex-shim production Coach —
fires all 4 tools, grounds every concrete claim, handles bad input honestly, coaches well.

## 2026-06-24 — naming-accuracy guardrail added to both agents (prod activated v6)

The "Fool's Mate" slip was an UNGROUNDED pattern name from the reasoning LLM, not a tool/server bug:
the MCP/Apex tools return only numbers + moves + opening names (openings ARE grounded — name_opening is
a longest-prefix lookup in chess-mcp/src/openings.js, which is why the opening name was always right).
Mate/tactical pattern names had no tool and no instruction governing them, so the model free-associated.

Fix = instruction guardrail in the "How to coach" block (NOT a server change — user's call, correct):
"Name openings and tactical/mating patterns accurately. Use the opening tool... Only name a specific
mating pattern (Scholar's Mate, Fool's Mate, smothered mate, back-rank mate) when you are certain it
fits; if unsure, describe the pattern instead of naming it. Do not invent pattern names the way you
would not invent an evaluation."

- Production Chess_Coach: edited source → validate (success) → publish → activate = **v6**. Verified on
  the activated agent: the mate-in-1 test now returns "Scholar's Mate" (was "Fool's Mate"), engine move
  Qxf7# still grounded. DONE.
- Chess_Coach_MCP: same instruction added to source. ALSO backfilled the 4 native MCP action blocks
  from the decoded v4 (exact source:/target:/inputs incl. the titled labels) so source finally matches
  the live builder agent. **Validated clean — confirming hand-authored mcpTool:// source compiles**
  (resolves an open skill-ref question). NOT published: per user, the source-over-builder publish (would
  be v5) is held to avoid risking the builder linkage during a wording fix. Source is updated + ready;
  builder v4 remains the activated MCP version. To ship the MCP wording fix without the source-publish
  risk, paste the instruction line in the builder → Save→Commit→Activate.

## 2026-06-24 — source-published MCP actions VALIDATE but DON'T FIRE (rolled back to builder v4)

Tried to finish Chess_Coach_MCP from source: backfilled the 4 native MCP action blocks (exact
source:/target:/inputs from the decoded builder v4) + added the naming guardrail, validated clean,
published + activated = v5. v5's planner-bundle metadata looked GREAT — all 4 mcpTool actions with
correct 1XOg… tool-record invocationTargets AND clean developer names (analyze_fen/best_move/etc.,
nicer than the builder's hash names).

BUT v5 doesn't work: every chess utterance deflected to ambiguous_question / off_topic, and the MCP
server logs showed NO /mcp call. Isolation (head-to-head, same org/server/utterances):
  - builder v4  → fires (Qxf7# + "Scholar's Mate", real /mcp call)
  - source v5   → deflects, no /mcp call
  - prod v6 (same guardrail, Apex actions) → fires → guardrail exonerated
  - re-activated v4 after all the re-syncing → still fires → registration re-sync exonerated
So the ONLY variable is builder-add vs. source-publish of the MCP actions. Conclusion: the builder
does a binding/registration step for mcpTool:// actions that `publish authoring-bundle` does NOT —
correct metadata + tool IDs are necessary but not sufficient; the planner won't invoke them.

Recovery: `sf agent activate --api-name Chess_Coach_MCP --version 4` → experiment agent working again
(v4 active). Source file keeps the backfilled bindings as REFERENCE (accurate transcription of v4) but
now carries a loud ⚠️ DO-NOT-SOURCE-PUBLISH warning block + the note that the naming guardrail is NOT
yet live on the MCP agent (v4 predates it; apply via builder if wanted). Lesson promoted to skill ref
mcp-tool-actions.md §8.

Net: builder is the source of truth for any MCP-using subagent. The whole MCP action lifecycle is
builder/activation-bound, not source-publish-bound (compounds: drafts not retrievable; authoring-bundle
preview can't fire MCP; now: source publish can't bind MCP).

Production Chess_Coach (v6, Apex + naming guardrail) is unaffected and fully working.

## 2026-06-24 — ROOT CAUSE FOUND (from reasoning trace): source publish poisons MCP binding

The MCP agent deflecting to off_topic was NOT the guardrail, descriptions, context, or non-determinism.
The builder Preview reasoning trace settled it. On the failing turn, the coach topic's planner was
handed the standard "you MUST use a tool, NEVER use general knowledge" protocol — but the ONLY tools in
its available list were `go_to_ambiguous_question` and `go_to_off_topic`. The 4 MCP engine tools were
NOT offered to the planner at all. So, ordered to call a tool and having only the two transition tools,
it called both → routed to off_topic. It never "chose" off_topic over analyze_fen; analyze_fen wasn't on
the menu.

Why the tools weren't on the menu: source-publish contamination. Decoding the activated bundles:
  - v4 (pure builder): 4 mcpTool targets, ZERO hand-authored comments → tools offered → fires 5/5.
  - v7 (and v5/v6): contains my SOURCE FILE's action-definition blocks verbatim, including the
    "Backfilled from the activated builder" comment → tools present in metadata but NOT presented to
    the planner → deflects 0/5.
`sf agent publish authoring-bundle` OVERWROTE the builder's working draft with my .agent file, and every
builder version built afterward (v6, v7) inherited the poisoned baseline. (This is the §8 finding, now
proven at the planner level, not just inferred from behavior.)

FIX: rolled active version back to v4 (pure builder) → fires 5/5, confirmed. Made the SOURCE FILE safe so
it can never re-poison: removed the mcpTool:// action references + definitions, restored the MCP-ACTION-
SLOT note with a loud do-not-source-publish warning, and pointed to the committed v4 agentScript as the
canonical binding reference. Source validates. Skill ref §8 rewritten: "source publish is not inert for
MCP — it is actively destructive (overwrites builder draft, poisons lineage)."

STILL OPEN: the naming guardrail is NOT on the MCP agent (v4 predates it). Must be added in the BUILDER
forward from v4 (edit coach instructions → Save→Commit→Activate), NEVER via source publish. Lower priority
— prod Chess_Coach (v6) has the guardrail and is the demo agent; the MCP agent is the experiment/reference.

## 2026-06-24 — NEXT UP (planned, not yet built): headless Agent-API coach + MIAW toggle

Plan written to ~/.claude/plans/so-i-have-a-delegated-clarke.md (FEATURE PLAN section). Approved approach;
build starts after a /compact. Summary so it survives context loss:

GOAL: coach auto-responds to the player's moves, via a SECOND, toggleable implementation path.
  - Apex coach (Chess_Coach) → MIAW = existing, unchanged (reactive, interactive Q&A path).
  - MCP coach (Chess_Coach_MCP) → NEW headless Agentforce **Agent API** (server-to-server REST). Rails
    controls the send, so the app auto-posts after each PLAYER move and renders the agent's grounded reply.
  - In-app toggle flips between the two (localStorage). Showcases two impl paths.

GROUNDED AGENT API FACTS (browser-extracted from developer.salesforce.com/docs/ai/agentforce, 2026-06-24):
  - Headless agents only; NOT type "Agentforce (Default)". Chess_Coach_MCP is AgentforceServiceAgent → OK.
  - Auth = External Client App (ECA), client-credentials flow. Scopes: api, refresh_token/offline_access,
    chatbot_api, sfap_api. "Issue JWT-based access tokens." Run-As an API-only user. Token via
    POST {MY_DOMAIN}/services/oauth2/token (grant_type=client_credentials).
  - Endpoints (base https://api.salesforce.com, 120s timeout → HTTP 500 on timeout):
      start:  POST /einstein/ai-agent/v1/agents/{AGENT_ID}/sessions  (externalSessionKey UUID, instanceConfig.endpoint=MY_DOMAIN, bypassUser)
      send:   POST /einstein/ai-agent/v1/sessions/{SESSION_ID}/messages  (message.sequenceId++, type "Text", text)
      end:    DELETE /einstein/ai-agent/v1/sessions/{SESSION_ID}
  - Context: API supports custom variables (external visibility + "set by API") per turn — but we chose the
    simpler EMBED-IN-MESSAGE path: Rails composes each turn's text with live move + FEN + opponent Elo +
    player name. No agent/builder changes (MCP coach grounds on FEN via its MCP tools).

USER DECISIONS (locked): (1) auto-comment after PLAYER move only; the turn's text includes the computer's
reply as context; PASS OPPONENT STRENGTH/ELO (user is adding a chess.com-Elo difficulty selector to the app
later — plumb a difficulty {label,elo} field now, default from engine depth). (2) embed context in message.
(3) USER creates the ECA in Setup, gives me consumer key/secret + AGENT_ID + My Domain URL; secrets go in
env/Heroku config vars (AGENTFORCE_CONSUMER_KEY/SECRET), never in repo.

REPO STATE: no server→SF OAuth, no HTTP gem, no ECA yet (all net-new). Reuse: identity_token.rb JWT/key-from-
ENV pattern, agent_deployments.yml + AgentDeployment registry, Solid Cache (token+session caching), jwt gem,
game_state.js event bus. Use Net::HTTP (stdlib) — no new gem.

FILES (per plan): NEW app/services/agentforce_token.rb, app/services/agent_api_client.rb,
app/controllers/agent_chats_controller.rb, app/javascript/controllers/agent_chat_controller.js. MODIFIED
agent_deployments.yml (+mode discriminator, chess_mcp_headless entry), agent_deployment.rb, routes.rb,
chess_controller.js (emit chess:turn-complete after computer reply), game_state.js (difficulty), 
games/show.html.erb (toggle + panel), importmap.rb, agentforce_controller.js (gate MIAW init on mode).

BLOCKING ON USER: ECA creation in Setup → consumer key/secret + AGENT_ID(Chess_Coach_MCP) + My Domain URL.

---

## 2026-06-24 01:03 EDT — BUILT: MIAW live-context fix + headless Agent-API coach scaffold (code complete; 2 user-owned stops remain)

Built both 2026-06-24 feature plans in one pass (plan approved, user asleep — ran everything that
doesn't need them). All Ruby + JS parse; app boots/eager-loads clean; registry + route helpers verified
via runner; full test suite 9/9 green (MIAW path unbroken). NOT committed (commit only when asked), NOT
deployed, Chess_Coach_MCP builder untouched / never source-published.

### Feature A — MIAW coach sees LIVE state mid-conversation (`setSessionContext`)
Root cause the user hit ("coach only knows my moves at chat-open"): the whole prechat pipeline is
conversation-start-only. Fix = the `utilAPI.setSessionContext()` Context-Events API the user surfaced from
SCRT/FDE (session-start-only `setHiddenPrechatFields` CONFIRMED; `setSessionContext` pushes into a LIVE
conversation; eng-flagged brittle on rapid-fire → debounce).
- `agentforce_controller.js`: added `pushLiveContext()` → `setSessionContext([{name:"_AgentContext",
  value:{valueType:"StructuredValue", value: gameStateForPrechat()}}])`. Fired on ready + on
  `chess:state-changed`, **debounced 400ms**. Kept `setHiddenPrechatFields` seeding as-is. Guards on
  isReady + `utilAPI?.setSessionContext`.
- Also gated MIAW bootstrap on coach mode (only inits when localStorage `coachMode` == "miaw") so it
  doesn't fight the headless panel.
- ⚠️ UNVERIFIED (the one real unknown, platform-side): how `_AgentContext` reaches the agent's reasoning —
  does it populate the existing `@MessagingSession.Chess_*__c` context (zero agent change) or need a
  builder tweak on Chess_Coach? → BINDING PROBE is verification step 1 (push a known FEN, ask the coach to
  echo it). Once confirmed, fold into docs/miaw-prechat-to-agent-guide.md (paid-for-once).

### Feature B — headless Agent-API coach + coach-mode toggle (auto-comments on moves)
- `config/agent_deployments.yml`: added `mode:` discriminator (`miaw` on chess_support) + new
  `chess_mcp_headless` entry (mode: agent_api, agent_id PLACEHOLDER, my_domain_url, api_base). Secrets NOT
  here — ENV `AGENTFORCE_CONSUMER_KEY`/`_SECRET`.
- `app/models/agent_deployment.rb`: new fields (agent_id/my_domain_url/api_base) + `miaw?`/`agent_api?` +
  class-level `AgentDeployment.agent_api`.
- `app/services/agentforce_token.rb`: client-credentials OAuth mint (Net::HTTP), cached in Rails.cache w/
  absolute expiry (skew 60s), `refresh!` for 401s.
- `app/services/agent_api_client.rb`: start_session/send_message/end_session vs
  api.salesforce.com/einstein/ai-agent/v1/…, Bearer from AgentforceToken, 120s read timeout, one 401-retry,
  `TimeoutError`, `self.reply_text` extractor.
- `app/controllers/agent_chats_controller.rb` + nested routes (`resource :agent_chat` under games):
  create/message/destroy. **Composes the grounded prompt server-side** ("I'm <name> playing White against a
  ~<elo> engine. I just played <SAN> (FEN before …). The engine replied <SAN> (FEN now …). Coach me…").
  Session handle {session_id, sequence, external_key} cached per `agent_session:<user>:<game>`; lazy start;
  free-text follow-ups supported. Player name derived from email local-part (headless bypasses Contact).
- `chess_controller.js`: emits `chess:turn-complete` after the computer reply (playerMove{san,fenBefore} via
  move.before, computerMove{san,fenAfter} via reply.after, difficulty). Sets difficulty from depth on connect.
- `game_state.js`: added `difficulty {label,elo}` + `difficultyForDepth()` (depth→Elo placeholder map; the
  upcoming chess.com selector just sets this).
- `agent_chat_controller.js` (NEW): self-contained chat panel; listens `chess:turn-complete` (debounced
  300ms, busy-coalesced), POSTs turns + manual questions, lazy session create, DELETE on game-over/unload.
  Self-gates on coachMode=="headless".
- `coach_toggle_controller.js` (NEW) + toggle UI in games/show.html.erb: flips localStorage `coachMode` and
  reloads so exactly one path wires up. (Both new controllers auto-pinned via pin_all_from — no importmap
  edit needed.)

### TWO USER-OWNED STOPS (everything is built up to these):
1. **ECA creds** — create the External Client App in Setup (client-credentials, scopes api/refresh_token/
   chatbot_api/sfap_api, Run-As API-only user) → give consumer key/secret + AGENT_ID(Chess_Coach_MCP) + My
   Domain. Then: set Heroku/env `AGENTFORCE_CONSUMER_KEY`/`_SECRET`, fill agent_id + my_domain_url in the
   yaml. Smoke: `rails runner` → AgentforceToken#access_token, then AgentApiClient start/send.
2. **`_AgentContext` binding probe** (Feature A verify step 1) — decides whether Chess_Coach needs a 1-line
   builder edit. Code's done either way.

---

## 2026-06-24 07:34 EDT — Headless coach LIVE-credential verified + User Verification last-mile SOLVED

Two big unblocks this morning.

### Headless Agent-API coach proven end-to-end against the real org
User created the External Client App ("Chess Headless Agent API", API name Chess_Headless_Agent_API,
Distribution=Local) and supplied the consumer key/secret. Tested against the live org:
- AgentforceToken#access_token → mints a 2062-char JWT (client-credentials flow + Run-As user correct).
- AgentApiClient start→send→end round-trip → real coach reply, clean teardown.
- GROUNDED prompt (composed exactly like the controller, 1.e4 e5 with real FENs) → coach named the
  "Open Game", confirmed e4 was the engine's top move, recommended Nf3. Grounding via MCP tools works.
- Bug found + fixed during the test: `Net::HTTP` is NOT autoloaded in this Rails app → added explicit
  `require "net/http"/"uri"/"json"` to both services. Tests still 9/9.
- Secrets persisted: added `dotenv-rails` (dev/test group) + gitignored `.env` (local); set Heroku config
  vars AGENTFORCE_CONSUMER_KEY/SECRET on chess-agent-jwt (release v16). Both confirmed loading from ENV.
- agent_id (0Xxg8000000neKTCAY, type ExternalCopilot — headless-eligible) + my_domain_url written into
  agent_deployments.yml (grabbed live via BotDefinition query + org display).
- NOTE: new code is NOT yet deployed to Heroku (config vars are live, code push pending user go-ahead);
  NOT committed.

### User Verification last-mile RESOLVED — the "Add User Verification" checkbox was hidden by the edit entry point
The 2026-06-23 OPEN ITEM (conversations stuck UNAUTH; checkbox "doesn't exist") is SOLVED, and it was a
Setup-UI inconsistency, not a missing/Beta feature. **Editing an individual SECTION from the channel
DETAIL page renders a reduced form that omits "Add User Verification"; full Edit from the channels LIST
VIEW shows it.** Check it there, bind the JSON Web Keyset, save → conversations bind AUTH with a real
ContactId; MessagingChannel.IsAuthenticated=true. End-to-end verified identity now works. Folded into
docs/agentforce-user-verification-guide.md (open item → RESOLVED note; Last verified bumped to 2026-06-24).
General lesson worth remembering: if a Setup field you expect is missing, re-open the record via full Edit
from the list view before concluding the feature isn't there.

---

## 2026-06-24 (afternoon) — Chess_FEN__c null for the VERIFIED coach: root cause = conversation continuity

Long hunt, big payoff. After verification went live, the Apex coach (MIAW) stopped knowing the live
position — `MessagingSession.Chess_FEN__c` came back **null** on every new chat. Chased it through
four layers before the data settled it.

**What it was NOT (each ruled out with evidence, not theory):**
- NOT a seed-timing / Turbo-lifecycle bug. Shipped v20 (hasActiveGame gate) + v21/v23 (isWidgetReady
  seeding) — sound fixes, but the null survived all of them.
- NOT the double bootstrap init. The v22 diagnostics DID catch a real bug: on a list→game Turbo nav,
  `connect()`/`loadBootstrap` fired twice and injected a 2nd ESW bootstrap → "Cannot read properties
  of undefined" from bootstrap.min.js; the 2nd `boot.init()` reset the prechat buffer. Fixed in v23 by
  tracking inject+init on `window` (the only thing surviving a Turbo body swap) → single init, no
  TypeError. Worth fixing — but it was NOT the cause of the null.
- NOT an SCRT2 front-door drop (prechat-guide Gotcha 0). Metadata still had Pre-Chat active + all 5
  hidden fields; channel param-mappings non-empty; flow runs (it sets EndUserContactId every time).
- NOT a config change at 14:54. No republish flipped anything.

**What it IS (proven by grouping MessagingSessions on `ConversationId`):**
- Anonymous (UNAUTH) chats: each open = a NEW ConversationId → prechat consumed at create → FEN lands
  EVERY time.
- Verified (AUTH) chats: **13 opens over 3 hours ALL shared ONE ConversationId (0dwg8000000ISQrAAO).**
  Only the first (14:16, the create) carried a FEN; all 12 resumes → null. The browser resumes the
  one persistent conversation via `continuityAccessToken` (seen in the Network waterfall).
- Hidden prechat is consumed ONLY at conversation creation. A verified user never re-creates their
  conversation, so `setHiddenPrechatFields` is a silent no-op on every resume. That's the whole bug —
  and it's architectural (verification ⇒ continuity), not a wiring mistake.

**Both client→agent freshness channels are dead for the verified path:** prechat (consumed once) and
`utilAPI.setSessionContext` (the intended mid-conversation API — but the v22/v23 logs show it's "not
available" on this widget build).

**Decided fix:** an Apex action the agent calls each turn to re-fetch live game state server-side,
keyed by the verified Contact's email (game is persisted to Rails every move). Pull, not push →
continuity is irrelevant, and it reuses the same grounding the headless coach already does. (Rejected:
end+recreate the conversation per open — would force prechat to re-run but destroy verified
continuity/history.)

Captured as a "read this first" section in docs/miaw-prechat-to-agent-guide.md (the ConversationId
query is the diagnostic). Diagnostics (DEBUG=true) still in agentforce_controller.js — strip once the
Apex-pull path is in and verified.

---

## 2026-06-25 — Verified coach SOLVED end-to-end (continuity trap, conversation reset, live pull)

Closed the multi-day saga. The verified MIAW coach now (a) can be reset to a fresh conversation
in-page and (b) tracks the live board every turn. Both confirmed live (session 0dwg8000000Ih3JAAS:
Chess_Player_Email__c=jacob.connors3@gmail.com + FEN set + Contact linked + repeated
/coach/game_state 200s).

THE CHAIN OF DISCOVERIES (each ruled out before the next):
1. Verified conversation is keyed on the JWT `sub`. clearSession + launchChat both re-resume the SAME
   ConversationId for the same email — even after upgrading WebV1→WebV2 (in-place upgrade; the v2 code
   snippet is byte-identical to v1, only server behavior changes; unlocks launchChat
   shouldStartNewConversation + setSessionContext, neither of which actually broke continuity).
   launchChat gotcha: must call it on onEmbeddedMessagingButtonCreated, not onEmbeddedMessagingReady
   (else "API not available before onEmbeddedMessagingButtonCreated").
2. RESET FIX: mint the JWT with a unique subject — sub = local+r<nonce>@domain. New subject → SCRT2
   creates a NEW conversation. Proven: +r subject made a fresh ConversationId; same-email always reused.
   Routing flow strips the +tag back to the real email for Contact match (split formula: Raw_Subject
   extracts uid:, Verified_Email canonicalizes by dropping the +tag).
3. v9 moved get_live_game from before_reasoning (entry-only → stale) into reasoning (per-turn). But it
   STILL didn't fire because it keyed on @MessagingEndUser.ContactId, which arrives NULL in agent
   context at reasoning time (even though the flow sets it on the record + the bot maps it). This also
   explains why the by-name greeting never worked — get_player_name starved on the same null ContactId.
4. LIVE-STATE FIX (v10): carry the player's EMAIL through the prechat pipeline (new Chess_Player_Email
   custom param → flow var → MessagingSession.Chess_Player_Email__c → linked var) and key get_live_game
   on it (Apex now takes an email input used directly; Rails /coach/game_state?email= already existed).
   Email rides the same channel that reliably delivers FEN. The .agent publish AUTO-wired the field into
   Agent Context (no manual Edit-Included-Fields step needed — a source-driven-publish win).
5. LAST GOTCHA: new prechat field landed null while FEN landed — same setHiddenPrechatFields call. Cause:
   ESD not republished (Gotcha 0 — SCRT2 drops unpublished hidden fields). Republish + a fresh-subject
   reset conversation (so the field lands on a post-republish CREATE) → everything populated.

Net architecture for "app data → verified agent, always current":
  identity JWT (unique sub for reset) → prechat (FEN + player email) → flow writes MessagingSession.*__c
  → agent reads email var, runs get_live_game(email) EVERY turn → Rails returns the live board.
ContactId is NOT in the path (unreliable in agent context). Folded into
docs/miaw-prechat-to-agent-guide.md (rewrote the "continuity trap" section as SOLVED).

---

## 2026-06-25 — Productized the "New chat" reset + added an opponent skill-level picker

Two app-side features. Both verified locally (Rails suite green: 23 runs; Stockfish behavior
confirmed by headless worker probe).

### 1. "New chat" reset is now a real button (no console script)
The reset's actual mechanism was always "mint a JWT with a unique subject" (the verified
conversation is keyed on `sub`; clearSession+launchChat alone only RESUME — the continuity trap).
Until now that unique subject was injected by a console `fetch`-override hack. Productized it:
- `/identity_token?reset=<nonce>` → `IdentityToken` splices the nonce in as a `+r<nonce>`
  sub-address (`local+r<nonce>@domain`). Non-alphanumerics stripped (tag-safe); blank/garbage/nil
  nonce falls back to the plain email so we never mint an unmatched subject. The routing flow's
  existing `Verified_Email` formula strips the `+r<nonce>` tag back to the real email → Contact
  still matches. Round-trip unit-tested both sides.
- `agentforce_controller.js`: the ↻ New chat button rotates a STICKY nonce
  (`localStorage["agentforce:resetNonce:<email>"]`) then runs the proven clearSession → ready →
  buttonCreated → launchChat sequence. Sticky because the token-expiry re-mint must reuse the SAME
  subject, or it would silently fork the thread mid-chat. Namespaced per-email; cleared on sign-out
  (sign-out = clean slate). `setIdentityToken()` now appends `&reset=<nonce>` whenever one is set.
  Turned RESET_DEBUG off (the cure was the subject, not the event ordering).

### 2. Opponent skill-level picker (Beginner → Expert)
- `game_state.js` now owns the `LEVELS` table (single source of truth): each tier has an `elo`
  label + Stockfish `skill` (0–20) + search `depth`. `getLevel`/`setLevel` persist to
  `localStorage["chessLevel"]`, mirror `{label,elo}` into the shared snapshot, and dispatch
  `chess:level-changed`. Replaced the old depth-guessing `difficultyForDepth` helper.
- `engine.js`: `bestMove(fen,{depth,skill})` emits `setoption name Skill Level value <skill>` before
  each `go` (serialized through the existing queue, so no race). `evaluate()` ALWAYS uses full
  strength (20) — the eval bar stays honest regardless of opponent level. We always emit the option
  (incl. 20) so a weak move can't leak into the next analysis or vice-versa.
- `chess_controller.js`: computer move uses the level's skill+depth; reacts to `chess:level-changed`
  mid-game (next move adopts it, no reload). `level_select_controller.js` + a styled `<select>` in
  the game header render `LEVELS` and call `setLevel` on change.
- The headless MCP coach already composes "against a ~<elo>-rated engine (<label>)" from the
  snapshot's `difficulty`, so the picker drives the strength the coach cites with zero coach changes.

GOTCHA (paid for once): the vendored asm.js Stockfish (ddugovic multi-variant) supports
`Skill Level` but its option list does NOT include `UCI_LimitStrength`/`UCI_Elo` — an Elo-based
handicap would have silently no-op'd. Confirmed by driving the worker headlessly: Skill 0 scatters
into weak moves (a3, h4, Bf1) while Skill 20 plays the tight best move. (Also burned time on a test
harness bug: rescanning the buffered UCI lines kept matching a STALE `bestmove`, making every
position look identical — fixed with a monotonic line cursor. The engine was fine; the probe wasn't.)

---

## 2026-06-25 — Headless coach latency: probe killed the streaming plan; shipped indicator + engine cap

User: "the headless coach latency is pretty rough." Planned to stream the Agent API reply
(`/messages/stream` SSE → ActionController::Live → ReadableStream). **A Step-0 probe of the live
`Chess_Coach_MCP` SSE endpoint killed that plan before any code was written** — the single most
valuable thing this pass did.

THE PROBE (timestamped SSE events against the real agent):
- Simple Q (no engine): total 8.6s, ALL events at +8.6s.
- "e4" + name opening: 9.7s, all at the end.
- Blunder analysis (engine tools): 20s — one PROGRESS_INDICATOR at +8s, then the full 487-char
  INFORM reply + END_OF_TURN at +20s.
**Agentforce buffers the entire turn and emits every SSE event (incl. the reply text) in ONE burst at
END_OF_TURN. Text never arrives progressively.** So end-to-end streaming = same frozen wait, then a
one-shot dump → ~0 perceived gain for a lot of plumbing. Dropped Lever A entirely. Where the time
goes: ~8s irreducible planner-LLM baseline (even a no-tool reply), +~12s on tool turns (multiple
LLM↔MCP round-trips + engine search). The 8s baseline is a planner/model concern (in-builder), left
out of scope this pass.

SHIPPED INSTEAD (both app/server-side, no agent republish):
1. **Perceived — animated "thinking" indicator** (`agent_chat_controller.js` + `.agent-dots` CSS).
   The request stays the sync `fetch(messageUrl)`; while it's in flight we show bouncing dots + a
   label that advances through stages ("Reading the board" → "Consulting the engine" → "Weighing your
   options" → "Writing your coaching", holding on the last). Clears the instant the reply/error lands.
   Honors `prefers-reduced-motion` (static label). Makes the 8–20s wait read as active, not frozen.
2. **Actual — capped MCP engine time** (`chess-mcp/src/engine.js`, `tools.js`). `DEFAULT_DEPTH` 14→12
   and a new `DEFAULT_MOVETIME = 700`ms; `analyze()` now issues `go depth D movetime M` (Stockfish
   stops at whichever limit hits first), threaded through all three engine tools (`explain_move`
   analyzes twice, so it gains most). Bounds per-call wall-clock predictably on the shared Basic dyno.
   Local smoke: explain_move 0.51s, analyze 0.24s, verdicts/best-moves unchanged. All 10 MCP tests +
   23 Rails tests green.

Both Heroku dynos are **Basic** (verified `heroku ps`) — never sleep, so cold-start was NOT the
problem (ruled out early). Lesson worth keeping: **probe the platform's actual streaming behavior
before building a streaming UI** — a buffered-turn agent makes token-streaming pointless.
