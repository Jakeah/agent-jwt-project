// Chess coaching MCP server (Stockfish-backed).
//
// Exposes four tools to the Agentforce chess-coach agent over Streamable HTTP (the transport
// Agentforce uses to reach a remote MCP server):
//   - analyze_fen     : evaluation + best line for a position
//   - best_move        : the engine's top move (SAN + UCI) for a position
//   - explain_move     : was a played move good? compare it to the engine's best
//   - name_opening     : name the opening from a list of moves
//
// Run: `npm start` (PORT from env, default 8080). STOCKFISH_PATH points at the engine binary.

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { analyzeFen, bestMove, explainMove, nameOpeningTool } from "./tools.js";
import { mountRest } from "./rest.js";

// The four coaching operations live in tools.js (shared with the REST facade). Each MCP tool is
// a thin wrapper: validate via zod, call the shared fn, serialize the result as MCP text content.
const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

function buildServer() {
  const server = new McpServer({ name: "chess-mcp", version: "0.1.0" });

  // Each param carries .meta({ title, description }). In zod v4 .describe() is sugar for
  // .meta({description}); folding title in alongside it emits a JSON-schema `title` per property.
  // EXPERIMENT (2026-06-24): Agentforce stamps `label: "string"` on every MCP-action input when the
  // tool schema has no `title`. Adding titles here is the server-side attempt to make the platform
  // surface a real `label:` instead of the placeholder. See skill ref mcp-tool-actions.md §5.
  server.tool(
    "analyze_fen",
    "Evaluate a chess position given as FEN. Returns the engine evaluation (White's perspective) and the best continuation.",
    { fen: z.string().meta({ title: "FEN Position", description: "Position in Forsyth-Edwards Notation" }),
      depth: z.number().int().min(4).max(20).optional().meta({ title: "Search Depth", description: "Search depth (default 14)" }) },
    async (args) => asText(await analyzeFen(args))
  );

  server.tool(
    "best_move",
    "Return the engine's best move for a position (FEN), in both SAN and UCI.",
    { fen: z.string().meta({ title: "FEN Position", description: "Position in FEN" }),
      depth: z.number().int().min(4).max(20).optional().meta({ title: "Search Depth", description: "Search depth (default 14)" }) },
    async (args) => asText(await bestMove(args))
  );

  server.tool(
    "explain_move",
    "Judge a move played from a position. Compares the played move to the engine's best and reports the evaluation swing so you can explain whether it was good, inaccurate, or a blunder.",
    { fen: z.string().meta({ title: "FEN Position", description: "Position BEFORE the move, in FEN" }),
      move: z.string().meta({ title: "Move Played", description: "The move that was played, in SAN (e.g. 'Nf3') or UCI (e.g. 'g1f3')" }),
      depth: z.number().int().min(4).max(20).optional().meta({ title: "Search Depth", description: "Search depth (default 14)" }) },
    async (args) => asText(await explainMove(args))
  );

  server.tool(
    "name_opening",
    "Name the chess opening from a sequence of moves in SAN.",
    { moves: z.array(z.string()).meta({ title: "Moves (SAN)", description: "Moves in SAN order, e.g. ['e4','e5','Nf3','Nc6','Bb5']" }) },
    async (args) => asText(nameOpeningTool(args))
  );

  return server;
}

// --- Streamable HTTP transport ---
//
// MCP Streamable HTTP is session-based: the client's first POST is `initialize` (no session
// header) and the server replies with an Mcp-Session-Id; subsequent POSTs carry that header.
// We keep one transport+server per session id so the handshake state survives across requests.

const app = express();
app.use(express.json());

const transports = {}; // sessionId → StreamableHTTPServerTransport

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "chess-mcp" }));

// Plain JSON REST facade under /api/* — called from Salesforce Apex (the supported path while
// the native mcpTool:// agent-action binding is blocked in Beta). Same engine, no MCP handshake.
mountRest(app);

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId && transports[sessionId];

    if (!transport) {
      // New session — only valid on an `initialize` request.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
      const server = buildServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
  }
});

// The SDK also issues GET (SSE stream) and DELETE (session teardown) on the same endpoint.
const replaySession = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId && transports[sessionId];
  if (!transport) return res.status(400).send("Unknown or missing session id");
  await transport.handleRequest(req, res);
};
app.get("/mcp", replaySession);
app.delete("/mcp", replaySession);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`chess-mcp listening on :${PORT} (stockfish: ${process.env.STOCKFISH_PATH || "stockfish"})`));
