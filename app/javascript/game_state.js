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
  // Opponent strength the headless coach mentions ("vs a ~1300 engine"). Set from the selected
  // level (see LEVELS / setLevel). { label, elo } — elo is approximate.
  difficulty: { label: "Intermediate", elo: 1300 },
};

// Discrete opponent levels — the single source of truth for the strength picker. Each tier controls
// how the computer MOVES: `skill` = Stockfish "Skill Level" (0–20; lower = weaker/blunder-prone)
// and `depth` = its search depth. The eval bar is NOT affected by this — it always analyzes at full
// strength so the coaching stays honest; the level only handicaps the opponent's own play. `elo` is
// an approximate label the coach mentions. Expert == the analysis engine's own strength.
export const LEVELS = [
  { id: "beginner",     label: "Beginner",     elo: 600,  skill: 0,  depth: 4 },
  { id: "casual",       label: "Casual",       elo: 900,  skill: 4,  depth: 6 },
  { id: "intermediate", label: "Intermediate", elo: 1300, skill: 8,  depth: 9 },
  { id: "advanced",     label: "Advanced",     elo: 1700, skill: 14, depth: 11 },
  { id: "expert",       label: "Expert",       elo: 2100, skill: 20, depth: 12 },
];

const DEFAULT_LEVEL_ID = "intermediate";
const LEVEL_KEY = "chessLevel";

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS.find((l) => l.id === DEFAULT_LEVEL_ID);
}

// The current opponent level — a client preference persisted in localStorage (no server state),
// shared by the board (engine params) and the coaches (the strength they cite).
export function getLevel() {
  try {
    return levelById(window.localStorage.getItem(LEVEL_KEY));
  } catch {
    return levelById(DEFAULT_LEVEL_ID); // localStorage blocked → default
  }
}

// Set the opponent level: persist it, mirror its strength into the shared snapshot (so the coaches
// pick it up at once), and announce it so the live board re-arms the engine for the next move. The
// chess controller listens for "chess:level-changed"; game_state stays the one writer of difficulty.
export function setLevel(id) {
  const level = levelById(id);
  try {
    window.localStorage.setItem(LEVEL_KEY, level.id);
  } catch {
    /* localStorage blocked — the in-page event still applies the choice for this session */
  }
  updateGameState({ difficulty: { label: level.label, elo: level.elo } });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chess:level-changed", { detail: { level } }));
  }
  return level;
}

export function updateGameState(patch) {
  Object.assign(state, patch);
  if (typeof window !== "undefined") {
    window.__chessGameState = { ...state };
    // Notify listeners (the agentforce controller) so they can re-seed the chat's hidden prechat
    // fields with the current board. MIAW captures those fields at conversation start, so keeping
    // them current means a chat opened mid-game starts with the live position, not page-load.
    window.dispatchEvent(new CustomEvent("chess:state-changed", { detail: { ...state } }));
  }
  return state;
}

export function getGameState() {
  return { ...state };
}

// True only when a real game is loaded on the page. The agentforce controller is mounted on every
// authenticated page (it's in the layout), but game_state is a module singleton that resets to the
// untouched starting position on each full page load and only gets real data once a chess
// controller publishes (which sets gameId). Opening the chat from the games LIST — or before any
// move — would otherwise seed the coach with a blank/start position, and it (correctly) replies
// "I don't see any moves." Gate context-seeding on this so the coach only gets game state when
// there genuinely is a game.
export function hasActiveGame() {
  return state.gameId != null;
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

// The signed-in player's email, rendered into a meta tag by the layout (authenticated only).
// Passed as a hidden prechat field so the coach can pull the live game by email — the reliable
// identity path, since @MessagingEndUser.ContactId arrives null in the agent's context at reasoning.
function playerEmail() {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="chess-player-email"]')?.content || "";
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
    Chess_Player_Email: playerEmail(),
  };
}
