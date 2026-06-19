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

// Flatten the snapshot into the string key/value shape MIAW hidden prechat fields expect.
// Keys here must match the parameter-mapped custom fields configured on the MIAW channel
// (Phase 4) so they land as conversation variables the coach agent can read.
export function gameStateForPrechat() {
  return {
    Chess_PGN: state.pgn || "",
    Chess_FEN: state.fen || "",
    Chess_Turn: state.turn === "w" ? "White" : "Black",
    Chess_Move_Count: String(state.moveCount),
    Chess_Status: state.status || "active",
  };
}
