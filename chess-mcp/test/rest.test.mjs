// Tests for the plain JSON REST facade (src/rest.js) — the path Salesforce Apex uses.
// Boots the server and hits the /api/* endpoints with plain fetch (no MCP handshake).
// Run: `node --test`. Skips gracefully if the stockfish binary is absent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8124;
const BASE = `http://localhost:${PORT}`;
const stockfishBin = process.env.STOCKFISH_PATH || "stockfish";
const haveStockfish = spawnSync(stockfishBin, ["--help"], { timeout: 3000 }).error === undefined ||
  spawnSync("which", [stockfishBin]).status === 0;

let server;

before(async () => {
  if (!haveStockfish) return;
  server = spawn(process.execPath, [join(root, "src/server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));
});

after(() => server?.kill());

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

test("POST /api/analyze returns an eval + best move", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { status, json } = await post("/api/analyze", { fen: START, depth: 10 });
  assert.equal(status, 200);
  assert.equal(typeof json.evaluationCp, "number");
  assert.ok(json.bestMove);
});

test("POST /api/best-move returns a UCI move", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { json } = await post("/api/best-move", { fen: START, depth: 10 });
  assert.match(json.bestMoveUci, /^[a-h][1-8][a-h][1-8]/);
});

test("POST /api/explain-move judges a weak move", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { json } = await post("/api/explain-move", { fen: AFTER_E4, move: "f6", depth: 12 });
  assert.ok(json.evalSwingCp > 30, `got ${json.evalSwingCp}`);
  assert.ok(["inaccuracy", "mistake", "blunder"].includes(json.verdict), `got ${json.verdict}`);
});

test("POST /api/name-opening recognizes the Ruy López", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { json } = await post("/api/name-opening", { moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] });
  assert.match(json.opening, /Ruy L/);
});

test("POST /api/analyze with an illegal FEN returns 400, not 500", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { status, json } = await post("/api/analyze", { fen: "not-a-fen" });
  assert.equal(status, 400);
  assert.ok(json.error);
});
