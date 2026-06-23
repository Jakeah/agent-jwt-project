// Shared, in-memory snapshot of the current game, published by the chess controller and read
// by the agentforce controller when it opens the chat (to seed hidden prechat fields).
//
// Kept deliberately tiny and framework-free: one mutable object plus get/set. Both Stimulus
// controllers live on the same page, so a module singleton is enough — no event bus needed.
// Also mirrored onto window.__chessGameState so the inline embed snippet (which isn't an ESM
// module) can read it if necessary.

const state = {
  gameId: null,
  pgn: "",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "w",          // "w" | "b" — side to move
  moveCount: 0,       // full moves played
  lastEval: null,     // { scoreCp, mate } from the engine, White's perspective
  status: "active",
};

export function updateGameState(patch) {
  Object.assign(state, patch);
  if (typeof window !== "undefined") window.__chessGameState = { ...state };
  return state;
}

export function getGameState() {
  return { ...state };
}

// MIAW custom parameters are capped at 255 chars (Phase 4 gotcha). PGN of a long game blows
// past that, so keep the OPENING — the head of the PGN — which is what lets the coach name the
// opening and reason about the plan. We drop whole trailing moves (never a partial token) and
// append an ellipsis so the agent knows the tail was truncated. FEN (always short) remains the
// position-of-record for any concrete analysis, so trimming the narration costs nothing.
const PGN_MAX = 255;

export function trimPgn(pgn, max = PGN_MAX) {
  if (!pgn || pgn.length <= max) return pgn || "";
  const ellipsis = " …";
  const budget = max - ellipsis.length;
  // Cut at the last full-move boundary that fits (split on spaces, never mid-token).
  let out = "";
  for (const token of pgn.split(" ")) {
    if ((out ? out.length + 1 : 0) + token.length > budget) break;
    out = out ? `${out} ${token}` : token;
  }
  return (out || pgn.slice(0, budget)) + ellipsis;
}

// Flatten the snapshot into the string key/value shape MIAW hidden prechat fields expect.
// Keys here must match the custom parameters / channel variable names configured on the MIAW
// channel (Phase 4) so they land as conversation variables the coach agent can read.
export function gameStateForPrechat() {
  return {
    Chess_PGN: trimPgn(state.pgn || ""),
    Chess_FEN: state.fen || "",
    Chess_Turn: state.turn === "w" ? "White" : "Black",
    Chess_Move_Count: String(state.moveCount),
    Chess_Status: state.status || "active",
  };
}
