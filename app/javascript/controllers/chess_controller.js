import { Controller } from "@hotwired/stimulus";
import { Chess } from "chess.js";
import { Engine } from "engine";
import { updateGameState, difficultyForDepth } from "game_state";
import { PIECE_SVG } from "pieces";

// Full piece names, for spelling a move out loud ("Knight to f3").
const PIECE_NAMES = { k: "King", q: "Queen", r: "Rook", b: "Bishop", n: "Knight", p: "Pawn" };

// Turn a chess.js verbose move into how a player would say it aloud — the learning aid in the
// left panel. Handles captures, castling, en passant, promotion, check and checkmate.
function spokenMove(move) {
  if (!move) return "";
  if (move.flags.includes("k")) return withSuffix("Castles kingside", move);
  if (move.flags.includes("q")) return withSuffix("Castles queenside", move);

  const piece = PIECE_NAMES[move.piece];
  const verb = move.flags.includes("c") || move.flags.includes("e") ? "takes" : "to";
  let phrase = `${piece} ${verb} ${move.to}`;
  if (move.flags.includes("e")) phrase += " en passant";
  if (move.promotion) phrase += `, promotes to ${PIECE_NAMES[move.promotion]}`;
  return withSuffix(phrase, move);
}

function withSuffix(phrase, move) {
  if (move.san.endsWith("#")) return `${phrase} — checkmate`;
  if (move.san.endsWith("+")) return `${phrase} — check`;
  return phrase;
}

// Renders an interactive chess board, plays the user (White) against Stockfish (Black),
// shows a live eval bar + best-move hint, and persists each move to the Rails game.
//
// The board is self-rendered (Unicode glyphs + Tailwind) — no jQuery/chessboard.js.
// chess.js owns rules/legality; the Engine wrapper owns Stockfish (computer move + analysis).
export default class extends Controller {
  static values = {
    gameId: Number,
    fen: String,
    moveUrl: String,
    finishUrl: String,
    depth: { type: Number, default: 12 },
  };

  // Track the most recent move (both colors) so the left panel can show its notation + spoken form.
  lastMove = null;

  connect() {
    this.chess = new Chess(this.fenValue || undefined);
    this.engine = new Engine();
    this.selected = null;   // currently selected square, e.g. "e2"
    this.legalTargets = [];
    this.thinking = false;
    // Opponent strength derived from search depth (until the Elo selector lands). Published in
    // the shared snapshot so the headless coach can say "vs a ~1200 engine".
    this.difficulty = difficultyForDepth(this.depthValue);
    this.#render();
    this.#publishState({ difficulty: this.difficulty });
    this.#analyze();
  }

  disconnect() {
    this.engine?.terminate();
  }

  // --- interaction ---

  onSquareClick(event) {
    if (this.thinking || this.chess.isGameOver() || this.chess.turn() !== "w") return;
    const square = event.currentTarget.dataset.square;

    if (this.selected && this.legalTargets.includes(square)) {
      this.#playUserMove(this.selected, square);
      return;
    }

    // (Re)select one of the user's own pieces.
    const piece = this.chess.get(square);
    if (piece && piece.color === "w") {
      this.selected = square;
      this.legalTargets = this.chess.moves({ square, verbose: true }).map((m) => m.to);
    } else {
      this.selected = null;
      this.legalTargets = [];
    }
    this.#render();
  }

  // --- move flow ---

  #playUserMove(from, to) {
    // Auto-queen on promotion for simplicity in the demo.
    const move = this.chess.move({ from, to, promotion: "q" });
    this.selected = null;
    this.legalTargets = [];
    if (!move) return this.#render();
    this.lastMove = move;

    this.#render();
    this.#persist();

    if (this.#checkGameOver()) return;

    // Computer replies after a short beat, then we re-analyze.
    this.thinking = true;
    this.#setStatus("Computer is thinking…");
    this.engine.bestMove(this.chess.fen(), { depth: this.depthValue }).then((mv) => {
      let reply = null;
      if (mv) {
        reply = this.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion || "q" });
        if (reply) this.lastMove = reply;
      }
      this.thinking = false;
      this.#render();
      this.#persist();
      // Announce the completed turn (player move + computer reply) so the headless MCP coach can
      // auto-comment. chess.js verbose moves carry .before/.after FENs, .san, .color.
      this.#announceTurn(move, reply);
      if (!this.#checkGameOver()) this.#analyze();
    });
  }

  // Dispatch a completed-turn event the headless coach panel listens for. Player-move-only
  // cadence: one event per player action, carrying the computer's reply as context. The MIAW
  // path ignores this (it reacts to chat messages, not board events).
  #announceTurn(playerMove, computerMove) {
    if (!playerMove) return;
    window.dispatchEvent(new CustomEvent("chess:turn-complete", {
      detail: {
        gameId: this.gameIdValue,
        playerMove: { san: playerMove.san, fenBefore: playerMove.before },
        computerMove: computerMove
          ? { san: computerMove.san, fenAfter: computerMove.after }
          : null,
        difficulty: this.difficulty,
      },
    }));
  }

  #analyze() {
    this.engine.evaluate(this.chess.fen(), { depth: this.depthValue }).then((ev) => {
      this.#renderEval(ev);
    });
  }

  #checkGameOver() {
    if (!this.chess.isGameOver()) return false;

    let status = "draw";
    let result = "½–½";
    if (this.chess.isCheckmate()) {
      status = "checkmate";
      result = this.chess.turn() === "w" ? "0–1 (Black wins)" : "1–0 (White wins)";
    } else if (this.chess.isStalemate()) {
      status = "stalemate";
    }
    this.#setStatus(`Game over — ${status}${result ? ` · ${result}` : ""}`);
    this.#finish(status, result);
    this.#render();
    return true;
  }

  // --- persistence (Rails) ---

  #persist() {
    this.#patch(this.moveUrlValue, { fen: this.chess.fen(), pgn: this.chess.pgn() });
    this.#publishState();
  }

  // Mirror the live position into the shared snapshot the chat widget reads on open.
  #publishState(extra = {}) {
    updateGameState({
      gameId: this.gameIdValue,
      pgn: this.chess.pgn(),
      fen: this.chess.fen(),
      turn: this.chess.turn(),
      moveCount: this.chess.moveNumber() - (this.chess.turn() === "w" ? 1 : 0),
      status: this.chess.isGameOver() ? "over" : "active",
      ...extra,
    });
  }

  #finish(status, result) {
    this.#patch(this.finishUrlValue, { status, result });
  }

  #patch(url, body) {
    fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content,
      },
      body: JSON.stringify(body),
    });
  }

  // --- rendering ---

  #render() {
    const board = this.chess.board(); // 8x8 from rank 8 → rank 1
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];

    // Board: an 8x8 grid of squares, plus a left rank gutter (8→1) and a bottom file gutter (a→h)
    // so the player can read coordinates while learning. The gutters are an extra row/column in a
    // 9-col grid wrapping the squares.
    let cells = "";
    board.forEach((row, r) => {
      // Rank label on the left edge of each row.
      cells += `<div class="flex items-center justify-center w-5 text-xs font-medium text-slate-400">${8 - r}</div>`;
      row.forEach((cell, c) => {
        const square = files[c] + (8 - r);
        const dark = (r + c) % 2 === 1;
        const isSel = this.selected === square;
        const isTarget = this.legalTargets.includes(square);
        const isLast = this.lastMove && (this.lastMove.from === square || this.lastMove.to === square);
        const base = dark ? "bg-board-dark" : "bg-board-light";
        const ring = isSel ? "ring-4 ring-inset ring-board-highlight" : "";
        const lastRing = isLast && !isSel ? "ring-4 ring-inset ring-board-highlight/60" : "";
        const piece = cell
          ? `<span class="block w-[86%] h-[86%] drop-shadow-sm">${PIECE_SVG[cell.color + cell.type.toUpperCase()]}</span>`
          : "";
        const dot = isTarget && !cell ? '<span class="absolute w-3.5 h-3.5 rounded-full bg-black/25"></span>' : "";
        const capRing = isTarget && cell ? "ring-[3px] ring-inset ring-black/30" : "";
        cells += `
          <div data-action="click->chess#onSquareClick" data-square="${square}"
               class="relative aspect-square flex items-center justify-center
                      cursor-pointer ${base} ${ring} ${lastRing} ${capRing} hover:brightness-105 transition">
            ${dot}${piece}
          </div>`;
      });
    });
    // Bottom file gutter: an empty corner cell, then a..h under each column.
    let fileGutter = '<div class="w-5"></div>';
    files.forEach((f) => {
      fileGutter += `<div class="text-center text-xs font-semibold text-slate-400">${f}</div>`;
    });

    const boardHtml = `
      <div class="select-none w-full max-w-[34rem] mx-auto">
        <div class="grid grid-cols-[1.25rem_repeat(8,minmax(0,1fr))] rounded-xl overflow-hidden ring-1 ring-black/10 shadow-lift">
          ${cells}
        </div>
        <div class="grid grid-cols-[1.25rem_repeat(8,minmax(0,1fr))] mt-1.5">
          ${fileGutter}
        </div>
      </div>`;

    // Side panels: eval bar (left of board) + last-move card (right). Lays out as a row on wider
    // cards, stacking gracefully when the board column is narrow.
    const movePanel = this.#movePanelHtml();

    this.element.innerHTML = `
      <div class="flex flex-col sm:flex-row gap-5 items-center sm:items-start justify-center">
        <div class="flex sm:flex-col items-center gap-2 order-2 sm:order-1">
          <div class="h-6 w-40 sm:h-[28rem] sm:w-7 bg-ink-900 rounded-full relative overflow-hidden ring-1 ring-black/10">
            <div data-chess-evalfill class="absolute bottom-0 left-0 right-0 bg-white transition-all duration-500"
                 style="height:50%"></div>
          </div>
        </div>

        <div class="order-1 sm:order-2 flex-1 min-w-0 w-full">
          ${boardHtml}
          <div class="mt-4 flex items-center justify-between gap-3">
            <p data-chess-status class="text-sm font-medium text-slate-600">Your move (White).</p>
            <p data-chess-evaltext class="text-sm font-semibold text-ink-900">…</p>
          </div>
          <p data-chess-besttext class="text-xs text-slate-400 mt-1"></p>
        </div>

        ${movePanel}
      </div>`;
  }

  // The "last move" card: big SAN code + the spoken form (a learning aid).
  #movePanelHtml() {
    const m = this.lastMove;
    const mover = m ? (m.color === "w" ? "White" : "Black") : "";
    const code = m ? m.san : "—";
    const spoken = m ? spokenMove(m) : "Make a move to begin";
    return `
      <div class="order-3 w-full sm:w-44 shrink-0 rounded-xl bg-slate-50 border border-slate-100 p-4">
        <h3 class="font-semibold mb-1.5 text-xs uppercase tracking-wider text-slate-400">Last move</h3>
        <p class="text-xs text-slate-400 mb-0.5">${mover || "&nbsp;"}</p>
        <p class="text-4xl font-display font-extrabold tracking-tight text-ink-900 leading-none break-all">${code}</p>
        <p class="mt-2.5 text-sm text-slate-600 leading-snug">${spoken}</p>
      </div>`;
  }

  #renderEval(ev) {
    const fill = this.element.querySelector("[data-chess-evalfill]");
    const text = this.element.querySelector("[data-chess-evaltext]");
    const best = this.element.querySelector("[data-chess-besttext]");
    if (!fill) return;

    // Eval is from the side-to-move's perspective; normalize to White's perspective.
    const sign = this.chess.turn() === "w" ? 1 : -1;
    let whiteCp = ev.scoreCp != null ? ev.scoreCp * sign : null;
    let label;
    if (ev.mate != null) {
      const mateForWhite = ev.mate * sign;
      label = `Mate in ${Math.abs(ev.mate)} (${mateForWhite > 0 ? "White" : "Black"})`;
      whiteCp = mateForWhite > 0 ? 2000 : -2000;
    } else if (whiteCp != null) {
      label = `${whiteCp > 0 ? "+" : ""}${(whiteCp / 100).toFixed(2)} (White)`;
    } else {
      label = "—";
    }

    // Map centipawns to a 0–100% white-advantage bar (clamped at ±10 pawns).
    const clamped = Math.max(-1000, Math.min(1000, whiteCp ?? 0));
    fill.style.height = `${50 + (clamped / 1000) * 50}%`;
    text.textContent = label;
    if (best && ev.bestMoveUci) best.textContent = `Best: ${ev.bestMoveUci}`;

    // Carry the latest eval (White's perspective) into the shared snapshot so the coach can
    // reference it without re-running the engine.
    this.#publishState({ lastEval: { scoreCp: whiteCp, mate: ev.mate ?? null } });
  }

  #setStatus(msg) {
    const el = this.element.querySelector("[data-chess-status]");
    if (el) el.textContent = msg;
  }
}
