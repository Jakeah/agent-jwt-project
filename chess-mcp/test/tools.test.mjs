// End-to-end tests for the chess MCP server: boot it, connect a real MCP client over
// Streamable HTTP, and exercise each tool. Run: `node --test`.
//
// Requires the `stockfish` binary on PATH (or STOCKFISH_PATH). Skips gracefully if absent.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8123;
const stockfishBin = process.env.STOCKFISH_PATH || "stockfish";
const haveStockfish = spawnSync(stockfishBin, ["--help"], { timeout: 3000 }).error === undefined ||
  spawnSync("which", [stockfishBin]).status === 0;

let server, client;

before(async () => {
  if (!haveStockfish) return;
  server = spawn(process.execPath, [join(root, "src/server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
  client = new Client({ name: "test", version: "1.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  server?.kill();
});

const callJson = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

test("lists all four tools", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["analyze_fen", "best_move", "explain_move", "name_opening"]);
});

test("analyze_fen returns an eval and best move", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const r = await callJson("analyze_fen", { fen: START, depth: 10 });
  assert.equal(typeof r.evaluationCp, "number");
  assert.ok(r.bestMove, "should suggest a best move");
});

test("best_move on the start position is a sane opening move", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const r = await callJson("best_move", { fen: START, depth: 10 });
  assert.match(r.bestMoveUci, /^[a-h][1-8][a-h][1-8]/);
});

test("explain_move flags a weak move and praises the best", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const weak = await callJson("explain_move", { fen: AFTER_E4, move: "f6", depth: 12 });
  assert.ok(weak.evalSwingCp > 30, `f6 should lose value (got ${weak.evalSwingCp})`);
  assert.ok(["inaccuracy", "mistake", "blunder"].includes(weak.verdict), `got ${weak.verdict}`);

  const best = await callJson("explain_move", { fen: AFTER_E4, move: "e5", depth: 12 });
  assert.equal(best.verdict, "best");
});

test("name_opening recognizes the Ruy López", { skip: !haveStockfish && "stockfish not installed" }, async () => {
  const r = await callJson("name_opening", { moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] });
  assert.match(r.opening, /Ruy L/);
});
