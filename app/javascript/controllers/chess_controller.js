import { Controller } from "@hotwired/stimulus";
import { Chess } from "chess.js";
import { Engine } from "engine";
import { updateGameState } from "game_state";

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

  static PIECES = {
    wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
    bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
  };

  connect() {
    this.chess = new Chess(this.fenValue || undefined);
    this.engine = new Engine();
    this.selected = null;   // currently selected square, e.g. "e2"
    this.legalTargets = [];
    this.thinking = false;
    this.#render();
    this.#publishState();
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

    this.#render();
    this.#persist();

    if (this.#checkGameOver()) return;

    // Computer replies after a short beat, then we re-analyze.
    this.thinking = true;
    this.#setStatus("Computer is thinking…");
    this.engine.bestMove(this.chess.fen(), { depth: this.depthValue }).then((mv) => {
      if (mv) this.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion || "q" });
      this.thinking = false;
      this.#render();
      this.#persist();
      if (!this.#checkGameOver()) this.#analyze();
    });
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
    let html = '<div class="grid grid-cols-8 w-fit border-2 border-slate-800 select-none">';

    board.forEach((row, r) => {
      row.forEach((cell, c) => {
        const square = files[c] + (8 - r);
        const dark = (r + c) % 2 === 1;
        const isSel = this.selected === square;
        const isTarget = this.legalTargets.includes(square);
        const base = dark ? "bg-emerald-700" : "bg-emerald-100";
        const ring = isSel ? "ring-4 ring-inset ring-yellow-400" : "";
        const glyph = cell ? this.constructor.PIECES[cell.color + cell.type.toUpperCase()] : "";
        const dot = isTarget && !cell ? '<span class="absolute w-3 h-3 rounded-full bg-yellow-500/70"></span>' : "";
        const capRing = isTarget && cell ? "ring-4 ring-inset ring-yellow-500/80" : "";
        html += `
          <div data-action="click->chess#onSquareClick" data-square="${square}"
               class="relative w-14 h-14 md:w-16 md:h-16 flex items-center justify-center
                      text-4xl cursor-pointer ${base} ${ring} ${capRing}">
            ${dot}<span class="${cell?.color === "w" ? "text-white drop-shadow" : "text-slate-900"}">${glyph}</span>
          </div>`;
      });
    });

    html += "</div>";
    this.element.innerHTML = `
      <div class="flex gap-6 items-start flex-wrap">
        <div>
          ${html}
          <p data-chess-status class="mt-3 text-sm text-slate-600">Your move (White).</p>
        </div>
        <div class="w-48">
          <h3 class="font-semibold mb-2 text-sm uppercase tracking-wide text-slate-500">Analysis</h3>
          <div class="h-64 w-8 bg-slate-900 rounded relative overflow-hidden mb-2">
            <div data-chess-evalfill class="absolute bottom-0 left-0 right-0 bg-white transition-all"
                 style="height:50%"></div>
          </div>
          <p data-chess-evaltext class="text-sm text-slate-700">…</p>
          <p data-chess-besttext class="text-xs text-slate-500 mt-1"></p>
        </div>
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
