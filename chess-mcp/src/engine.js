// UCI wrapper around the native Stockfish binary for the MCP server.
//
// We use the native engine (not the npm WASM build) because it's fast, dependency-light, and
// trivially installable on Heroku via the apt buildpack. The binary path is configurable with
// STOCKFISH_PATH (Heroku) and falls back to `stockfish` on PATH (local brew install).
//
// Each analysis spawns a fresh process: cheap, fully isolated (no shared-state races across
// concurrent MCP requests), and the process exits cleanly via `quit`.

import { spawn } from "node:child_process";

const STOCKFISH = process.env.STOCKFISH_PATH || "stockfish";

export function analyze(fen, { depth = 14, movetime = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(STOCKFISH, [], { stdio: ["pipe", "pipe", "ignore"] });

    const info = { scoreCp: null, mate: null, bestMoveUci: null, pv: null, depth: 0 };
    let buffer = "";
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.stdin.write("quit\n"); } catch { /* closed */ }
      err ? reject(err) : resolve(info);
    };

    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* gone */ }
      finish(new Error("Stockfish timed out"));
    }, 20_000);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    });

    const handleLine = (line) => {
      if (line.startsWith("info") && line.includes(" score ")) {
        const cp = line.match(/score cp (-?\d+)/);
        const mate = line.match(/score mate (-?\d+)/);
        const pv = line.match(/ pv (.+)$/);
        const d = line.match(/ depth (\d+)/);
        if (cp) info.scoreCp = parseInt(cp[1], 10);
        if (mate) info.mate = parseInt(mate[1], 10);
        if (pv) { info.pv = pv[1].trim(); info.bestMoveUci = info.pv.split(" ")[0]; }
        if (d) info.depth = parseInt(d[1], 10);
      } else if (line.startsWith("bestmove")) {
        const mv = line.split(" ")[1];
        if (mv && mv !== "(none)") info.bestMoveUci = mv;
        finish();
      }
    };

    proc.on("error", (e) => finish(new Error(`Stockfish failed to start (${STOCKFISH}): ${e.message}`)));

    const send = (cmd) => proc.stdin.write(cmd + "\n");
    send("uci");
    send("isready");
    send("ucinewgame");
    send(`position fen ${fen}`);
    send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
  });
}
