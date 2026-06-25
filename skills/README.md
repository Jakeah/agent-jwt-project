# Agentforce skills (from the agent-jwt-project build)

Two reusable Claude Code skills distilled from a real Agentforce + custom-web-app build. Every
gotcha in them was verified in a live org and "paid for once" — they capture behavior the official
Salesforce docs are thin or silent on (MIAW User Verification, the verified-conversation continuity
trap, Enhanced Web Chat v1/v2, and native `mcpTool://` actions).

## What's here

- **`embedding-agentforce-messaging/`** — embedding an Agentforce agent into a custom web app via
  Messaging for In-App and Web (MIAW / Enhanced Web Chat). The embed bootstrap, User Verification
  (RS256 identity JWT, keyset, AuthScheme), passing live app data via hidden prechat, the
  verified-user continuity trap + fixes, v1↔v2, and SPA lifecycle gotchas.
- **`developing-agentforce-mcp/`** — wiring native `mcpTool://` actions into an agent. MCP-server
  registration, the `mcpTool://` target syntax, and the critical **§8** rule: MCP actions must be
  added in the **builder**, never source-published, or they validate but never fire.

These complement the official `agentforce-adlc` plugin skills (`developing-agentforce`,
`trace-agentforce`, etc.) and the `configuring-connected-apps` / `fetching-salesforce-docs` skills —
they don't replace them; the SKILL.md `DO NOT TRIGGER` sections cross-reference the boundaries.

## Install (per machine)

Copy each skill folder into `~/.claude/skills/`:

```bash
# from a checkout of this repo
cp -R skills/embedding-agentforce-messaging ~/.claude/skills/
cp -R skills/developing-agentforce-mcp      ~/.claude/skills/
```

…or unzip the shareable bundles (see `dist/skills/*.zip`):

```bash
unzip embedding-agentforce-messaging.zip -d ~/.claude/skills/
unzip developing-agentforce-mcp.zip      -d ~/.claude/skills/
```

Claude Code auto-discovers skills under `~/.claude/skills/`; they become available on next session
(or reload). Verify with `/skills` or by checking the skill is listed.

## Provenance + caveats

Captured 2026-06 against the `chess-agent` org. `mcpTool://` / `McpServerDefinition` and Enhanced
Web Chat v2 were Beta/undocumented at the time. The behavioral findings (continuity trap, the §8
source-publish hazard, ContactId-null-in-context) are durable; version-specific syntax may drift —
re-confirm against current docs (`fetching-salesforce-docs`) and your org before relying on a
specific detail.
