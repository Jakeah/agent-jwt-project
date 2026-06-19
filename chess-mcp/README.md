# chess-mcp

A Stockfish-backed **Model Context Protocol** server that gives the Agentforce chess-coach
agent real chess abilities. Agentforce connects to it as a remote MCP server over **Streamable
HTTP** and invokes its tools via `mcpTool://` actions.

## Tools

| Tool | Purpose |
|------|---------|
| `analyze_fen` | Evaluate a position (FEN) → eval (White's perspective) + best line |
| `best_move` | The engine's top move (SAN + UCI) for a position |
| `explain_move` | Judge a played move vs. the engine's best → verdict (best/good/inaccuracy/mistake/blunder) + eval swing |
| `name_opening` | Name the opening from a SAN move list |

Endpoint: `POST /mcp` (Streamable HTTP). Health: `GET /healthz`.

## Run locally

```bash
npm install
brew install stockfish      # or apt-get install stockfish
npm start                   # listens on :8080
npm test                    # boots the server + drives a real MCP client
```

`STOCKFISH_PATH` overrides the engine binary location (defaults to `stockfish` on PATH).

## Deploy to Heroku

Stockfish is a native binary, installed via the **apt buildpack**:

```bash
heroku create chess-mcp-<suffix>
heroku buildpacks:add --index 1 heroku-community/apt    # reads Aptfile → installs stockfish
heroku buildpacks:add --index 2 heroku/nodejs
heroku config:set STOCKFISH_PATH=/app/.apt/usr/games/stockfish
git subtree push --prefix chess-mcp heroku main          # this dir is a subfolder of the main repo
```

The apt buildpack installs stockfish under `/app/.apt/usr/games/stockfish` — hence the
`STOCKFISH_PATH` config var.

## Why native Stockfish (not the npm WASM build)

The `stockfish` npm package is an emscripten WASM module that's painful to drive headless in
Node (the worker handshake / `.wasm` locating fails when spawned as a CLI). The native binary
speaks UCI over stdio, is fast, and installs cleanly on Heroku via apt. Each analysis spawns a
short-lived process — isolated, no shared-state races across concurrent MCP requests.
