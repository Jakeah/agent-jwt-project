// Plain JSON REST facade over the shared chess tools (src/tools.js).
//
// Why this exists: Agentforce's native MCP agent-action binding (mcpTool://) is blocked in this
// Beta org — the MCP server + tool records never persist, so the agent can't target the tools.
// This facade exposes the SAME four operations as ordinary POST endpoints that a Salesforce Apex
// invocable action can call via a Named Credential HTTP callout (a fully supported path). No MCP
// session handshake, no SSE — just request → JSON.
//
// Endpoints (all POST, JSON body):
//   POST /api/analyze       { fen, depth? }            → analyzeFen result
//   POST /api/best-move     { fen, depth? }            → bestMove result
//   POST /api/explain-move  { fen, move, depth? }      → explainMove result
//   POST /api/name-opening  { moves: [..] }            → { opening }

import { analyzeFen, bestMove, explainMove, nameOpeningTool } from "./tools.js";

export function mountRest(app) {
  // Wrap each handler so a thrown error (e.g. illegal FEN) becomes a clean 400 with a message
  // the agent can relay, rather than a 500 stack.
  const handle = (fn) => async (req, res) => {
    try {
      const result = await fn(req.body ?? {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  };

  app.post("/api/analyze", handle(analyzeFen));
  app.post("/api/best-move", handle(bestMove));
  app.post("/api/explain-move", handle(explainMove));
  app.post("/api/name-opening", handle((body) => nameOpeningTool(body)));
}
