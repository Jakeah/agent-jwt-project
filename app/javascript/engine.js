// Thin wrapper around the Stockfish Web Worker (UCI protocol).
//
// Stockfish ships as an asm.js Web Worker (public/stockfish/stockfish.js). We talk to it
// over UCI and surface two promise-based calls the chess controller needs:
//   - bestMove(fen, { depth })  → { from, to, promotion } for the computer's reply
//   - evaluate(fen, { depth })  → { scoreCp, mate, bestMoveUci } for the analysis bar
//
// Both share one worker; calls are serialized through a simple queue so overlapping
// requests don't cross their `bestmove`/`info` lines.
//
// Strength: the computer's MOVE can be weakened via Stockfish's "Skill Level" option (0–20; lower
// blunders more), set per-call right before `go` so it can't bleed into the analysis. Pass
// { skill } to bestMove for a handicapped opponent; OMIT it for evaluate() so the eval bar always
// reflects full-strength, honest analysis regardless of the selected opponent level.

// Stockfish "Skill Level" range. 20 == full strength (the engine treats >=20 as no handicap).
const FULL_SKILL = 20;

export class Engine {
  constructor(workerUrl = "/stockfish/stockfish.js") {
    this.worker = new Worker(workerUrl);
    this.queue = [];
    this.current = null;
    this.lastInfo = null;

    this.worker.onmessage = (e) => this.#onLine(typeof e.data === "string" ? e.data : e.data?.data);
    this.#send("uci");
    this.#send("isready");
  }

  // Resolve the engine's preferred move from a position. Pass { skill } (0–20) to handicap the
  // opponent's choice; omit it for full strength.
  bestMove(fen, { depth = 12, skill = FULL_SKILL } = {}) {
    return this.#run(fen, depth, skill).then((r) => r.bestMoveUci ? this.#parseUci(r.bestMoveUci) : null);
  }

  // Resolve a position evaluation (centipawns from side-to-move's perspective, or mate-in-N).
  // Always full strength — the analysis must be honest no matter how weak the opponent is set.
  evaluate(fen, { depth = 12 } = {}) {
    return this.#run(fen, depth, FULL_SKILL).then((r) => ({
      scoreCp: r.scoreCp,
      mate: r.mate,
      bestMoveUci: r.bestMoveUci,
    }));
  }

  terminate() {
    this.worker.terminate();
  }

  // --- internals ---

  #run(fen, depth, skill) {
    return new Promise((resolve) => {
      this.queue.push({ fen, depth, skill, resolve });
      this.#drain();
    });
  }

  #drain() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.lastInfo = { scoreCp: null, mate: null, bestMoveUci: null };
    // Set the per-call skill before the search. Serialized through the queue, so this can't race
    // with another request's `go`. We always emit it (incl. the full-strength 20) so a weakened
    // move never leaks into the next full-strength analyze, and vice-versa.
    const skill = Math.max(0, Math.min(FULL_SKILL, this.current.skill ?? FULL_SKILL));
    this.#send(`setoption name Skill Level value ${skill}`);
    this.#send(`position fen ${this.current.fen}`);
    this.#send(`go depth ${this.current.depth}`);
  }

  #onLine(line) {
    if (!line) return;

    if (line.startsWith("info") && line.includes(" score ")) {
      const cp = line.match(/score cp (-?\d+)/);
      const mate = line.match(/score mate (-?\d+)/);
      const pv = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
      if (cp) this.lastInfo.scoreCp = parseInt(cp[1], 10);
      if (mate) this.lastInfo.mate = parseInt(mate[1], 10);
      if (pv) this.lastInfo.bestMoveUci = pv[1];
    }

    if (line.startsWith("bestmove")) {
      const mv = line.split(" ")[1];
      if (mv && mv !== "(none)") this.lastInfo.bestMoveUci = mv;
      const done = this.current;
      this.current = null;
      done?.resolve(this.lastInfo);
      this.#drain();
    }
  }

  #parseUci(uci) {
    return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined };
  }

  #send(cmd) {
    this.worker.postMessage(cmd);
  }
}
