/**
 * The graph as an MCP stdio server.
 *
 * Ports BirdClaw's `tools/mcp/graph_server.py`. The transport is the whole
 * reason this is safe to have: JSON-RPC over stdin and stdout, spawned as a
 * child process by whoever wants it. No port, no origin, nothing listening.
 * llama.cpp ships MCP over HTTP and its own SECURITY.md lists it among
 * "features not recommended for use in untrusted environments" — the networked
 * shape is the one with a problem.
 *
 *     npm run test:graph-server
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// A copy, because the portal may hold the real one and DuckDB is single-writer.
const data = mkdtempSync(path.join(tmpdir(), "graph-server-"));
try {
  cpSync(path.join(repo, "data", "graph.duckdb"), path.join(data, "graph.duckdb"));
} catch {
  // No graph yet: the server still has to speak the protocol correctly.
}

/** Send requests, close stdin, collect every response. */
function ask(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(repo, "server", "dist", "mcp", "graph-server.js")], {
      env: { ...process.env, DATA_DIR: data },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => {
      const lines = out.split("\n").filter(Boolean);
      try {
        resolve(lines.map((l) => JSON.parse(l)));
      } catch (e) {
        reject(new Error(`unparseable output: ${out.slice(0, 200)}`));
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    // Closed immediately: a scripted client writes and stops, and the answer
    // must still arrive. Getting this wrong loses every slow response.
    child.stdin.end();
    setTimeout(() => child.kill(), 90_000);
  });
}

// --- the handshake ---------------------------------------------------------
{
  const [init] = await ask([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
  ok("initialize is answered", init?.id === 1);
  ok("with a protocol version", init.result.protocolVersion === "2024-11-05");
  ok("and a server name", init.result.serverInfo.name === "phoenixclaw-graph");
  ok("declaring tools", Boolean(init.result.capabilities.tools));
}

// --- what is exposed, and what deliberately is not -------------------------
{
  const [list] = await ask([{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const names = list.result.tools.map((t) => t.name);
  ok("the read tools are listed", names.includes("graph_search") && names.includes("graph_get"));
  ok("including neighbours and an overview",
     names.includes("graph_neighbors") && names.includes("graph_overview"));

  // BirdClaw's version exposes graph_add and graph_relate. A writable memory
  // reachable over a pipe is a way to put beliefs into the agent without
  // passing the guard, which is the thing the taint model exists to prevent.
  ok("nothing can write", !names.some((n) => /add|relate|remember|forget|update/.test(n)));
  ok("every tool has a schema", list.result.tools.every((t) => t.inputSchema?.type === "object"));
}

// --- an answer survives stdin closing --------------------------------------
// A graph search takes longer than a pipe takes to close, so exiting on close
// lost the answer to anything still in flight.
{
  const out = await ask([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_overview", arguments: {} } },
  ]);
  const call = out.find((m) => m.id === 2);
  ok("a slow call is answered even though stdin closed", Boolean(call));
  ok("and returns content", Array.isArray(call.result.content));
  ok("as text", call.result.content[0].type === "text");
}

// --- protocol edges --------------------------------------------------------
{
  const out = await ask([
    { jsonrpc: "2.0", method: "initialized" },
    { jsonrpc: "2.0", id: 5, method: "ping" },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
    { jsonrpc: "2.0", id: 7, method: "nonsense" },
    { jsonrpc: "2.0", method: "notifications/something" },
  ]);

  ok("ping is answered", out.some((m) => m.id === 5 && m.result));
  ok("an unknown tool is an error", out.find((m) => m.id === 6)?.error?.code === -32601);
  ok("an unknown method is an error", out.find((m) => m.id === 7)?.error?.code === -32601);
  // Answering a notification is a protocol error in itself.
  ok("notifications get no reply", !out.some((m) => m.id === undefined || m.id === null));
}

// --- malformed input must not take the server down -------------------------
{
  const child = spawn("node", [path.join(repo, "server", "dist", "mcp", "graph-server.js")], {
    env: { ...process.env, DATA_DIR: data },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write("this is not json\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));

  const messages = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok("a parse error is reported", messages.some((m) => m.error?.code === -32700));
  ok("and the next request is still served", messages.some((m) => m.id === 9 && m.result));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
