// Shared chess-coaching logic — the single implementation behind BOTH transports:
//   - the MCP Streamable-HTTP server (src/server.js), used by native Agentforce mcpTool:// (Beta)
//   - the plain JSON REST facade (src/rest.js), called from Salesforce Apex (supported today)
//
// Each function takes plain args and returns a plain object (already JSON-serializable). The
// transports are thin: they parse input, call one of these, and serialize the result.

import { Chess } from "chess.js";
import { analyze } from "./engine.js";
import { nameOpening } from "./openings.js";

export const DEFAULT_DEPTH = 14;

// Format a centipawn/mate eval into a human phrase from White's perspective.
export function describeEval({ scoreCp, mate }, sideToMove) {
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
export function uciToSan(fen, uci) {
  if (!uci) return null;
  try {
    const game = new Chess(fen);
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    return move?.san ?? null;
  } catch {
    return null;
  }
}

// --- The four coaching operations ---

export async function analyzeFen({ fen, depth } = {}) {
  const game = new Chess(fen); // validates the FEN (throws if illegal)
  const info = await analyze(fen, { depth: depth ?? DEFAULT_DEPTH });
  const ev = describeEval(info, game.turn());
  return {
    evaluation: ev.text,
    evaluationCp: ev.whiteCp,
    bestMove: uciToSan(fen, info.bestMoveUci),
    bestMoveUci: info.bestMoveUci,
    principalVariation: info.pv,
    sideToMove: game.turn() === "w" ? "White" : "Black",
    depth: info.depth,
  };
}

export async function bestMove({ fen, depth } = {}) {
  new Chess(fen); // validate
  const info = await analyze(fen, { depth: depth ?? DEFAULT_DEPTH });
  return { bestMove: uciToSan(fen, info.bestMoveUci), bestMoveUci: info.bestMoveUci };
}

export async function explainMove({ fen, move, depth } = {}) {
  const d = depth ?? DEFAULT_DEPTH;
  const before = new Chess(fen);
  const sideToMove = before.turn();
  const moverSign = sideToMove === "w" ? 1 : -1; // White's-perspective cp → mover's perspective

  const beforeInfo = await analyze(fen, { depth: d });
  const bestSan = uciToSan(fen, beforeInfo.bestMoveUci);
  const beforeEval = describeEval(beforeInfo, sideToMove);
  const beforeMoverCp = (beforeEval.whiteCp ?? 0) * moverSign;

  let played;
  try {
    played = before.move(move) ||
      before.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.slice(4, 5) || undefined });
  } catch { played = null; }
  if (!played) {
    return { error: `Illegal or unparseable move: ${move}` };
  }

  const afterInfo = await analyze(before.fen(), { depth: d });
  const afterMoverCp = (describeEval(afterInfo, before.turn()).whiteCp ?? 0) * moverSign;
  const lossCp = beforeMoverCp - afterMoverCp;

  let verdict;
  if (lossCp >= 300) verdict = "blunder";
  else if (lossCp >= 100) verdict = "mistake";
  else if (lossCp >= 50) verdict = "inaccuracy";
  else if (played.san === bestSan || lossCp <= 10) verdict = "best";
  else verdict = "good";

  return {
    playedMove: played.san,
    engineBestMove: bestSan,
    verdict,
    evalSwingCp: Math.round(lossCp),
    evalBefore: beforeEval.text,
  };
}

export function nameOpeningTool({ moves } = {}) {
  return { opening: nameOpening(moves) };
}
