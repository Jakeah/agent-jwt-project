# CLAUDE.md — Chess App + Agentforce Verified-Identity Chat

A Ruby on Rails chess app that embeds a Salesforce Agentforce chat widget (Messaging for
In-App and Web). A logged-in Rails user's identity is passed to the chat via a signed **RS256
JWT** (Salesforce **User Verification**) so the conversation runs as a verified Contact. Built
as a reusable **SOMA/MOMA** (Single/Multi Org, Multi Agent) reference asset — the JWT minting
and widget embed are config-driven via `config/agent_deployments.yml`.

## Read these first (project context layers)

- **`build-log.md`** — append-only narrative. The fastest re-onboard: the whole arc, dead
  ends, gotchas, real names. Append (timestamped), never rewrite.
- **`docs/architecture-and-build.md`** — what was built and *why*, with Mermaid diagrams of
  the auth flow and the SOMA/MOMA generalization, plus a consolidated gotchas section.
- **`docs/demo-script.md`** — the presenter runbook (numbered, copy-pasteable). Kept separate
  from the architecture explanation.
- **`docs/agentforce-user-verification-guide.md`** — durable, findable-by-name reference for
  the JWT claim set + Salesforce Setup steps. Edit in place when a lesson is superseded; keep
  a `Last verified:` date.
- **`docs/miaw-prechat-to-agent-guide.md`** — how app data (the chess FEN/PGN) reaches the agent
  via MIAW hidden prechat fields. The 5-layer pipeline (Custom Parameter → Parameter Mapping →
  Omni-Flow Update Records → MessagingSession custom field → agent `@MessagingSession.X__c`), and
  why the direct `source: @context.*`/prechat binding does NOT work.

## Key facts

- **Salesforce org:** `chess-agent` (default `sf` target-org, set globally).
- **Hosting:** Heroku (Postgres add-on).
- **Rails binary:** use `bin/rails` — `/usr/bin/rails` is an Apple system stub that fails.
- **Two JWTs, two purposes:** Connected App / JWT Bearer OAuth authenticates the *app* to
  Salesforce APIs; the User Verification JWT authenticates the *end user* to the chat runtime.
  They are not interchangeable.
- **Signing:** RS256 (or RS512) only. Private key via `IDENTITY_JWT_PRIVATE_KEY` env var —
  never in the repo. Salesforce holds the public key.

## Conventions

- Commit in small logical chunks; write the message from the diff (the *why*). Commit only
  when asked.
- Version-control text formats only (md, code, config, Agent Script, SOQL). No binaries.
