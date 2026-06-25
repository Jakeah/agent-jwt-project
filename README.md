# Chess + Agentforce — verified-identity chat coach

A Ruby on Rails chess app (Devise login, client-side Stockfish + chess.js) that embeds a Salesforce
**Agentforce** chat coach via **Messaging for In-App and Web (MIAW)**. A logged-in user's identity is
passed to the chat through a signed **RS256 JWT** (Salesforce **User Verification**), so the
conversation runs as a *known, verified Contact* — and the coach can see the live board and greet the
player by name.

Built as a reusable **SOMA/MOMA** (Single/Multi-Org, Multi-Agent) reference: the JWT minting and the
widget embed are config-driven via `config/agent_deployments.yml`.

> **Demo environment notice.** Any Salesforce org domain/IDs and Heroku app URLs in this repo belong
> to a throwaway demo org and are **not secrets** — they grant no access on their own. All real
> credentials (the RS256 private key, the External Client App secret, the coach pull token) are read
> from environment variables and are **never** committed. Public keys/certs are committed by design.

## Two coach implementations (toggle in-app)

- **Apex coach → MIAW** (the embedded widget): reactive, verified-identity Q&A. Reads live game state
  via a per-turn server pull (see the continuity-trap notes below).
- **MCP coach → headless Agent API**: proactive, auto-comments on each move, driven server-to-server
  from Rails, grounded via native `mcpTool://` actions against a self-hosted Stockfish MCP server.

## How it works (the auth + data flow)

1. Browser loads the MIAW bootstrap; on ready, fetches a short-lived **RS256 identity JWT** from an
   authenticated Rails endpoint and hands it to `userVerificationAPI.setIdentityToken(...)`.
2. Salesforce verifies the JWT against a registered keyset (+ an active AuthScheme) → the conversation
   binds to a Contact.
3. Live game state reaches the agent via the **hidden-prechat pipeline** (Custom Parameter →
   Parameter Mapping → Omni-Flow → `MessagingSession` custom fields → agent linked vars), and stays
   fresh each turn via an Apex action that pulls the current board from Rails keyed by the player's
   email.

## Read these (project context layers)

- **`build-log.md`** — append-only narrative; the fastest re-onboard (the whole arc, dead ends, real
  names, every gotcha paid for once).
- **`docs/agentforce-user-verification-guide.md`** — the JWT claim set + Salesforce Setup steps.
- **`docs/miaw-prechat-to-agent-guide.md`** — how app data reaches the agent, and the **verified-user
  conversation-continuity trap** + its fixes (the hardest part of this build).
- **`CLAUDE.md`** — project conventions + the context-layer index.

## Reusable skills (`skills/`)

Two Claude Code skills distilled from this build, capturing behavior the official docs are thin on:

- **`embedding-agentforce-messaging`** — MIAW embed, User Verification, the prechat pipeline, the
  continuity trap, Enhanced Web Chat v1↔v2, SPA lifecycle gotchas.
- **`developing-agentforce-mcp`** — native `mcpTool://` actions, MCP-server registration, and the
  rule that MCP actions must be added in the builder (never source-published) or they silently never
  fire.

See `skills/README.md` to install.

## Stack

Rails 8 · Devise · Hotwired (Turbo + Stimulus, importmap — no bundler) · Tailwind v4 ·
client-side Stockfish (WASM) + chess.js · Salesforce Agentforce + MIAW · Heroku (Postgres).
A separate Node MCP server (Stockfish over Streamable HTTP) lives in `chess-mcp/`.

## Running locally

- Ruby via `bin/rails` (not `/usr/bin/rails`). `bin/setup` then `bin/dev` (Procfile.dev runs Puma +
  the Tailwind watcher).
- Secrets via `.env` (gitignored): `IDENTITY_JWT_PRIVATE_KEY`, `AGENTFORCE_CONSUMER_KEY/SECRET`,
  `COACH_PULL_TOKEN`. See `config/agent_deployments.yml` for the (non-secret) deployment registry.
- Tests: `bin/rails test`.

The Salesforce-side setup (agent, MIAW channel, User Verification keyset + AuthScheme, routing flow)
is documented step-by-step in the `docs/` guides.
