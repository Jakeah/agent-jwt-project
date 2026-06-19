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
