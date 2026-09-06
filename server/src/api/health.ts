import { Router } from "express";
import { nodeCount } from "../graph.js";
import { getDb, totalUsage } from "../db.js";
import { localModelConfigured } from "../llm.js";
import { portalToolNames } from "../pi/sdk-client.js";

/**
 * What this deployment can actually do right now.
 *
 * Every dependency here degrades silently by design — a failed embedding falls
 * back to keyword search, a missing local model skips extraction, no SearXNG
 * means no web search — and that is right for a request in flight and wrong for
 * a deployment. Conversation harvesting ran for a full day writing no entities
 * at all because LLAMA_BASE_URL was unset, and nothing anywhere said so: the
 * feature looked like it worked and the graph simply stayed empty.
 *
 * The boot log names what is missing, which helps whoever was watching the
 * console at the time and nobody afterwards. This answers the same question at
 * any moment, and answers the harder half too: *configured* is not *reachable*,
 * and the interesting failure is a server that was there this morning.
 */

/** Long enough for a cold local model, short enough not to hang a page load. */
const PROBE_TIMEOUT_MS = 4000;

export type Health = "ok" | "degraded" | "down" | "off";

export interface Dependency {
  name: string;
  status: Health;
  detail: string;
  /** What stops working without it — the part an operator actually needs. */
  costs?: string;
}

async function probe(url: string, init?: RequestInit): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: res.ok, detail: res.ok ? `${res.status}` : `HTTP ${res.status}` };
  } catch (e) {
    const message = (e as Error).message ?? "unreachable";
    return { ok: false, detail: /abort|timeout/i.test(message) ? "timed out" : message };
  }
}

async function embeddingHealth(): Promise<Dependency> {
  const url = process.env.EMBEDDING_BASE_URL;
  const costs = "memory search falls back to keywords — no semantic recall";
  if (!url) return { name: "embeddings", status: "off", detail: "EMBEDDING_BASE_URL unset", costs };

  const res = await probe(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "health" }),
  });
  if (!res.ok) return { name: "embeddings", status: "down", detail: res.detail, costs };

  /**
   * Reachable is not enough: a model of the wrong width is silently useless,
   * because graph.ts rejects any vector that is not EMBEDDING_DIM long and
   * every search quietly falls back to keywords. That is a configuration
   * mistake nobody would ever see.
   */
  try {
    const body = (await (
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "health" }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    ).json()) as { data?: { embedding?: number[] }[] };
    const dims = body.data?.[0]?.embedding?.length ?? 0;
    if (dims !== 768) {
      return {
        name: "embeddings",
        status: "degraded",
        detail: `returns ${dims} dimensions, the graph stores 768`,
        costs,
      };
    }
    return { name: "embeddings", status: "ok", detail: "768 dimensions" };
  } catch (e) {
    return { name: "embeddings", status: "down", detail: (e as Error).message, costs };
  }
}

async function extractionHealth(): Promise<Dependency> {
  const url = process.env.LLAMA_BASE_URL;
  const costs = "conversations and pages are recorded but no facts are extracted from them";
  if (!url || !localModelConfigured()) {
    return { name: "extraction", status: "off", detail: "LLAMA_BASE_URL unset", costs };
  }
  const res = await probe(`${url.replace(/\/+$/, "")}/v1/models`);
  return res.ok
    ? { name: "extraction", status: "ok", detail: "reachable" }
    : { name: "extraction", status: "down", detail: res.detail, costs };
}

async function searchHealth(): Promise<Dependency> {
  const url = process.env.SEARXNG_URL;
  const costs = "web_search is unavailable — the agent cannot look anything up";
  if (!url) return { name: "web search", status: "off", detail: "SEARXNG_URL unset", costs };
  const res = await probe(url);
  return res.ok
    ? { name: "web search", status: "ok", detail: "reachable" }
    : { name: "web search", status: "down", detail: res.detail, costs };
}

async function storageHealth(): Promise<Dependency[]> {
  const out: Dependency[] = [];
  try {
    const conn = await getDb();
    const rows = (await conn.runAndReadAll("SELECT count(*) AS n FROM sessions")).getRowObjectsJson();
    out.push({ name: "portal database", status: "ok", detail: `${(rows[0] as any).n} session(s)` });
  } catch (e) {
    out.push({
      name: "portal database",
      status: "down",
      detail: (e as Error).message,
      costs: "nothing works — sessions, history and settings all live here",
    });
  }
  try {
    out.push({ name: "knowledge graph", status: "ok", detail: `${await nodeCount()} node(s)` });
  } catch (e) {
    out.push({
      name: "knowledge graph",
      status: "down",
      detail: (e as Error).message,
      costs: "the agent has no memory beyond the conversation in front of it",
    });
  }
  return out;
}

/**
 * The tools a session would actually be given.
 *
 * Every other check here asks whether a *dependency* is reachable. This one
 * asks whether the portal is still itself: whether the agent, right now, would
 * be handed the tools it is written to use.
 *
 * It exists because that failed once with no error attached. Passing pi's
 * `tools` option instead of `defaultTools` left every session with seven
 * built-ins and none of the portal's own, and the only visible symptom was the
 * learning loop going quiet — which looks exactly like a loop with nothing to
 * do. It was found by noticing the audit log had gone flat, hours later.
 *
 * The floor is a count rather than a list on purpose. A named list would have
 * to be edited every time a tool is added, and a check nobody updates is a
 * check that eventually gets deleted. What this catches is the shape of the
 * failure — most of them missing at once — not the loss of any single one.
 */
const TOOL_FLOOR = 15;

function toolHealth(): Dependency {
  let names: string[];
  try {
    names = portalToolNames();
  } catch (e) {
    return {
      name: "agent tools",
      status: "down",
      detail: `could not be built: ${(e as Error).message}`,
      costs: "the agent has no memory, no plan and no web — it can only read files",
    };
  }

  const missing = ["graph_remember", "graph_recall", "task_plan", "web_fetch"].filter(
    (t) => !names.includes(t),
  );
  if (names.length < TOOL_FLOOR || missing.length) {
    return {
      name: "agent tools",
      status: "down",
      detail:
        `${names.length} registered` +
        (missing.length ? `, missing ${missing.join(", ")}` : `, expected at least ${TOOL_FLOOR}`),
      costs: "sessions are missing tools they are written to use, and will work around it silently",
    };
  }
  return { name: "agent tools", status: "ok", detail: `${names.length} registered` };
}

export function healthRouter(): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const dependencies = [
      ...(await storageHealth()),
      toolHealth(),
      await extractionHealth(),
      await embeddingHealth(),
      await searchHealth(),
    ];

    /**
     * `off` is not `down`.
     *
     * A dependency nobody configured is a choice, and reporting it as a failure
     * teaches people to ignore the health page — which is the one outcome worth
     * avoiding, since the page exists to be believed.
     */
    const status: Health = dependencies.some((d) => d.status === "down")
      ? "down"
      : dependencies.some((d) => d.status === "degraded")
        ? "degraded"
        : "ok";

    // What it has cost, beside what it can do. An unattended agent's running
    // total is the number nobody thinks to ask for until it matters.
    const usage = await totalUsage().catch(() => ({ tokensIn: 0, tokensOut: 0, cost: 0 }));
    res.json({ status, dependencies, usage, uptimeSeconds: Math.round(process.uptime()) });
  });

  return router;
}
