#!/usr/bin/env node
/**
 * The knowledge graph as an MCP stdio server.
 *
 * Ports BirdClaw's `tools/mcp/graph_server.py`, and the transport is the whole
 * reason it is safe to have: JSON-RPC 2.0 over **stdin and stdout**, spawned as
 * a child process by whoever wants it. There is no port, no origin, nothing
 * listening, and nothing to reach from another machine. It exists only while
 * something is holding the pipe.
 *
 * That distinction matters here. llama.cpp ships MCP over HTTP and its own
 * SECURITY.md lists it among "features not recommended for use in untrusted
 * environments", with the CORS proxy off by default. The networked shape is the
 * one with a problem; this one has no surface to have a problem with.
 *
 * The portal's own MCP *client* surface was removed rather than kept: it
 * configured `pi-mcp-adapter`, a third-party package that was never installed
 * and would have been unaudited code in the trust path. Reading the graph out
 * over a pipe you opened is a different proposition from letting arbitrary
 * servers register tools into the agent.
 *
 * **Read-only, deliberately.** This is the agent's accumulated memory of the
 * person it works for. Something on the other end of a pipe may look; writing
 * is the agent's own business, through its own tools, where the guard and the
 * constitution apply.
 *
 *     node server/dist/mcp/graph-server.js
 *
 * Nothing starts it automatically. Point an MCP client at that command when you
 * want it, and it stops when the client disconnects.
 */
import { createInterface } from "node:readline";
import {
  getNode,
  graphSnapshot,
  neighbors,
  personalRecall,
  searchNodes,
  type NodeRow,
} from "../graph.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "phoenixclaw-graph";
const SERVER_VERSION = "0.1.0";

interface Request {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * One JSON object per line on stdout, and nothing else ever.
 *
 * Anything written to stdout that is not a response corrupts the transport —
 * which is why every diagnostic in this file goes to stderr, the same rule
 * BirdClaw's server follows.
 */
function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const text = (body: string) => ({ content: [{ type: "text", text: body }] });

/** How a node reads to something that is not this agent. */
const describe = (n: NodeRow): string =>
  `${n.name} (${n.type}, confidence ${n.confidence.toFixed(2)}, seen ${n.observations}×)\n${n.summary}`;

/**
 * What is exposed.
 *
 * Four read tools. `graph_add` and `graph_relate` exist in BirdClaw's version
 * and are deliberately absent here: a writable memory reachable over a pipe is
 * a way to put beliefs into the agent without passing the guard, which is the
 * one thing the taint model exists to prevent.
 */
const TOOLS = [
  {
    name: "graph_search",
    description:
      "Search the agent's knowledge graph. Returns the closest matches with their type, " +
      "confidence and summary.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        limit: { type: "number", description: "Most results to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "graph_get",
    description: "Fetch one node by its exact name, with everything recorded about it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The node's exact name." } },
      required: ["name"],
    },
  },
  {
    name: "graph_neighbors",
    description:
      "What one node is connected to, and how — the relations either side of it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The node's exact name." } },
      required: ["name"],
    },
  },
  {
    name: "graph_overview",
    description:
      "A summary of the graph: how much is in it, of what kinds, and the best-established few.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "graph_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return text("No query given.");
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      // The unscoped search: a client over a pipe has no working directory of
      // its own, so project scoping would silently return nothing.
      const rows = await searchNodes(query, limit);
      return rows.length
        ? text(rows.map(describe).join("\n\n"))
        : text(`Nothing in memory matches "${query}".`);
    }
    case "graph_get": {
      const node = await getNode(String(args.name ?? ""));
      return node ? text(describe(node)) : text(`No node called "${args.name}".`);
    }
    case "graph_neighbors": {
      const rows = await neighbors(String(args.name ?? ""));
      return rows.length
        ? text(
            rows
              .map((r) =>
                r.direction === "out"
                  ? `${args.name} —${r.relation}→ ${r.name}`
                  : `${r.name} —${r.relation}→ ${args.name}`,
              )
              .join("\n"),
          )
        : text(`"${args.name}" is not connected to anything.`);
    }
    case "graph_overview": {
      const snap = await graphSnapshot(15);
      const counts = new Map<string, number>();
      for (const n of snap.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
      const kinds = [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
      return text(
        `${snap.nodes.length} of the best-established nodes (${kinds}), ${snap.edges.length} links between them.\n\n` +
          snap.nodes.slice(0, 10).map(describe).join("\n\n"),
      );
    }
    default:
      return undefined;
  }
}

async function handle(req: Request): Promise<void> {
  const { id, method } = req;
  const params = req.params ?? {};

  switch (method) {
    case "initialize":
      return send(
        ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        }),
      );

    // A notification: no id, no response. Answering one is a protocol error.
    case "initialized":
    case "notifications/initialized":
      return;

    case "tools/list":
      return send(ok(id, { tools: TOOLS }));

    case "tools/call": {
      const name = String(params.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) {
        return send(err(id, -32601, `Tool not found: ${name}`));
      }
      try {
        const result = await callTool(name, (params.arguments as Record<string, unknown>) ?? {});
        return send(ok(id, result));
      } catch (e) {
        // Reported as a JSON-RPC error rather than thrown: a crashed server
        // takes the client's whole session with it, and one bad call should
        // not.
        return send(err(id, -32603, `${name} failed: ${(e as Error).message}`));
      }
    }

    case "ping":
      return send(ok(id, {}));

    default:
      // Unknown notifications are ignored per the spec; only a request with an
      // id gets an error back.
      if (id !== undefined && id !== null) send(err(id, -32601, `Method not found: ${method}`));
  }
}

/**
 * Requests are answered in order, and the process outlives the last one.
 *
 * Two things go wrong without this. Handling concurrently means two searches
 * hit DuckDB's single-writer connection at once, which the portal already had
 * to serialise for. And exiting the moment stdin closes loses the answer to
 * anything still in flight: a client that writes one request and stops writing
 * — which is exactly how a scripted call behaves — gets nothing back, because
 * a graph search takes longer than a pipe takes to close.
 */
let queue: Promise<void> = Promise.resolve();
let closed = false;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req: Request;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return send(err(null, -32700, `Parse error: ${(e as Error).message}`));
  }
  queue = queue
    .then(() => handle(req))
    .catch((e) => {
      // Never rethrow into the chain: one failed request must not stop every
      // request after it from being answered.
      process.stderr.write(`graph-server: ${(e as Error).message}\n`);
    })
    .then(() => {
      if (closed) void finish();
    });
});

/** Exit once nothing is left to answer. */
async function finish(): Promise<void> {
  await queue.catch(() => {});
  process.exit(0);
}

lines.on("close", () => {
  closed = true;
  void finish();
});
