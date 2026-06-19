// Thin wrapper around the Stockfish Web Worker (UCI protocol).
//
// Stockfish ships as an asm.js Web Worker (public/stockfish/stockfish.js). We talk to it
// over UCI and surface two promise-based calls the chess controller needs:
//   - bestMove(fen, { depth })  → { from, to, promotion } for the computer's reply
//   - evaluate(fen, { depth })  → { scoreCp, mate, bestMoveUci } for the analysis bar
//
// Both share one worker; calls are serialized through a simple queue so overlapping
// requests don't cross their `bestmove`/`info` lines.

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

  // Resolve the engine's preferred move from a position.
  bestMove(fen, { depth = 12 } = {}) {
    return this.#run(fen, depth).then((r) => r.bestMoveUci ? this.#parseUci(r.bestMoveUci) : null);
  }

  // Resolve a position evaluation (centipawns from side-to-move's perspective, or mate-in-N).
  evaluate(fen, { depth = 12 } = {}) {
    return this.#run(fen, depth).then((r) => ({
      scoreCp: r.scoreCp,
      mate: r.mate,
      bestMoveUci: r.bestMoveUci,
    }));
  }

  terminate() {
    this.worker.terminate();
  }

  // --- internals ---

  #run(fen, depth) {
    return new Promise((resolve) => {
      this.queue.push({ fen, depth, resolve });
      this.#drain();
    });
  }

  #drain() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.lastInfo = { scoreCp: null, mate: null, bestMoveUci: null };
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
