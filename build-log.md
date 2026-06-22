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
