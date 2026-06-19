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
import { Chess } from "chess.js";
import { analyze } from "./engine.js";
import { nameOpening } from "./openings.js";

const DEFAULT_DEPTH = 14;

// Format a centipawn/mate eval into a human phrase from White's perspective.
function describeEval({ scoreCp, mate }, sideToMove) {
  const sign = sideToMove === "w" ? 1 : -1;
  if (mate != null) {
    const m = mate * sign;
    return { whiteCp: m > 0 ? 10000 : -10000, text: `forced mate in ${Math.abs(mate)} for ${m > 0 ? "White" : "Black"}` };
  }
  if (scoreCp == null) return { whiteCp: null, text: "unclear" };
  const whiteCp = scoreCp * sign;
  const pawns = (whiteCp / 100).toFixed(2);
  const who = whiteCp > 30 ? "White is better" : whiteCp < -30 ? "Black is better" : "roughly equal";
  return { whiteCp, text: `${whiteCp >= 0 ? "+" : ""}${pawns} (${who})` };
}

// Convert a UCI move (e2e4) to SAN (e4) in the context of a FEN.
function uciToSan(fen, uci) {
  if (!uci) return null;
  try {
    const game = new Chess(fen);
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    return move?.san ?? null;
  } catch {
    return null;
  }
}

function buildServer() {
  const server = new McpServer({ name: "chess-mcp", version: "0.1.0" });

  server.tool(
    "analyze_fen",
    "Evaluate a chess position given as FEN. Returns the engine evaluation (White's perspective) and the best continuation.",
    { fen: z.string().describe("Position in Forsyth-Edwards Notation"),
      depth: z.number().int().min(4).max(20).optional().describe("Search depth (default 14)") },
    async ({ fen, depth }) => {
      const game = new Chess(fen); // validates the FEN (throws if illegal)
      const info = await analyze(fen, { depth: depth ?? DEFAULT_DEPTH });
      const ev = describeEval(info, game.turn());
      const bestSan = uciToSan(fen, info.bestMoveUci);
      return { content: [{ type: "text", text: JSON.stringify({
        evaluation: ev.text,
        evaluationCp: ev.whiteCp,
        bestMove: bestSan,
        bestMoveUci: info.bestMoveUci,
        principalVariation: info.pv,
        sideToMove: game.turn() === "w" ? "White" : "Black",
        depth: info.depth,
      }) }] };
    }
  );

  server.tool(
    "best_move",
    "Return the engine's best move for a position (FEN), in both SAN and UCI.",
    { fen: z.string().describe("Position in FEN"),
      depth: z.number().int().min(4).max(20).optional() },
    async ({ fen, depth }) => {
      new Chess(fen);
      const info = await analyze(fen, { depth: depth ?? DEFAULT_DEPTH });
      return { content: [{ type: "text", text: JSON.stringify({
        bestMove: uciToSan(fen, info.bestMoveUci),
        bestMoveUci: info.bestMoveUci,
      }) }] };
    }
  );

  server.tool(
    "explain_move",
    "Judge a move played from a position. Compares the played move to the engine's best and reports the evaluation swing so you can explain whether it was good, inaccurate, or a blunder.",
    { fen: z.string().describe("Position BEFORE the move, in FEN"),
      move: z.string().describe("The move that was played, in SAN (e.g. 'Nf3') or UCI (e.g. 'g1f3')"),
      depth: z.number().int().min(4).max(20).optional() },
    async ({ fen, move, depth }) => {
      const d = depth ?? DEFAULT_DEPTH;
      const before = new Chess(fen);
      const sideToMove = before.turn();
      const moverSign = sideToMove === "w" ? 1 : -1; // White's-perspective cp → mover's perspective

      // Engine's view of the position before the move (White's perspective).
      const beforeInfo = await analyze(fen, { depth: d });
      const bestSan = uciToSan(fen, beforeInfo.bestMoveUci);
      const beforeEval = describeEval(beforeInfo, sideToMove);
      const beforeMoverCp = (beforeEval.whiteCp ?? 0) * moverSign;

      // Apply the played move (accept SAN or UCI).
      let played;
      try {
        played = before.move(move) ||
          before.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.slice(4, 5) || undefined });
      } catch { played = null; }
      if (!played) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Illegal or unparseable move: ${move}` }) }] };
      }

      // Engine's view AFTER the move (White's perspective again via describeEval), converted to
      // the mover's perspective. lossCp > 0 means the move gave away value.
      const afterInfo = await analyze(before.fen(), { depth: d });
      const afterMoverCp = (describeEval(afterInfo, before.turn()).whiteCp ?? 0) * moverSign;
      const lossCp = beforeMoverCp - afterMoverCp;

      let verdict;
      if (lossCp >= 300) verdict = "blunder";
      else if (lossCp >= 100) verdict = "mistake";
      else if (lossCp >= 50) verdict = "inaccuracy";
      else if (played.san === bestSan || lossCp <= 10) verdict = "best";
      else verdict = "good";

      return { content: [{ type: "text", text: JSON.stringify({
        playedMove: played.san,
        engineBestMove: bestSan,
        verdict,
        evalSwingCp: Math.round(lossCp),
        evalBefore: beforeEval.text,
      }) }] };
    }
  );

  server.tool(
    "name_opening",
    "Name the chess opening from a sequence of moves in SAN.",
    { moves: z.array(z.string()).describe("Moves in SAN order, e.g. ['e4','e5','Nf3','Nc6','Bb5']") },
    async ({ moves }) => {
      return { content: [{ type: "text", text: JSON.stringify({ opening: nameOpening(moves) }) }] };
    }
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
