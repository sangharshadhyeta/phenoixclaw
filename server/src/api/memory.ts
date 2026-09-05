import { Router } from "express";
import {
  neighbors,
  nodeCount,
  nodesByType,
  recentNodes,
  searchNodesSemantic,
  type NodeType,
} from "../graph.js";

/**
 * A window into what the agent knows.
 *
 * Everything else in this portal shows what the agent *did* — the transcript,
 * the audit log, a routine's last run. The graph is what it took away from all
 * of that, and until now the only way to see any of it was to ask the agent,
 * which is a poor way to check whether its memory is any good: you get its
 * account of its memory rather than the memory.
 *
 * That matters more now that the learning loop writes to it unattended. A
 * memory nobody inspects is a memory nobody can correct, and the loop is
 * capable of spending a day recording the same conclusion in slightly
 * different words.
 *
 * Read-only. The agent writes this — `graph_remember`, `graph_ingest`, the
 * Dream Cycle — and a fact edited behind its back is one it will re-derive and
 * be confused by. Correcting it is a conversation, which is also how you find
 * out why it believed the thing.
 */

const TYPES: NodeType[] = [
  "anchor", "user", "project", "concept", "fact", "skill",
  "episode", "workspace_note", "tool_cache", "page",
];

export function memoryRouter(): Router {
  const router = Router();

  /**
   * With a query, the same hybrid search the agent gets — so what you see is
   * what it would have found, not a different index that happens to be easier
   * to build a page on. Without one, whatever is most recent: the useful
   * default for "what has it been doing".
   */
  router.get("/memory", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const type = String(req.query.type ?? "").trim() as NodeType | "";
    const limit = Math.min(Number(req.query.limit) || 60, 200);

    try {
      const counts: Record<string, number> = {};
      for (const t of TYPES) {
        const n = await nodeCount(t);
        if (n) counts[t] = n;
      }

      const nodes = q
        ? await searchNodesSemantic(q, limit, type || undefined)
        : type
          ? await nodesByType(type, limit)
          : await recentNodes(limit);

      res.json({ total: await nodeCount(), counts, nodes });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** What one thing is connected to — the part a flat list cannot show. */
  router.get("/memory/neighbors", async (req, res) => {
    const name = String(req.query.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      res.json({ neighbors: await neighbors(name) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
