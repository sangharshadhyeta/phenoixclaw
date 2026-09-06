import { Router } from "express";
import {
  getNode,
  graphSnapshot,
  neighbors,
  removeNode,
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
  /**
   * Remove a belief.
   *
   * Reading the graph without being able to correct it is only half a window:
   * the learning loop writes unattended, and until now a wrong belief could be
   * *seen* and not touched — the only recourse was editing DuckDB by hand,
   * which nobody should have to do and which does not scale past the first few
   * mistakes. The agent has `graph_forget` for the same job; this is the
   * person's version of it.
   *
   * Bounded, but not identically to the tool — and the difference matters.
   *
   * `graph_forget` refuses `user` nodes because the *agent* should not unsay
   * what the person told it about themselves. This endpoint allows them,
   * because the person should: it is their own knowledge, they are the
   * authority on it, and `remember_user` can only add a correction beside a
   * wrong entry, never remove one. Refusing here left a mistaken preference
   * being read into every single prompt with no way to take it out short of
   * editing DuckDB by hand.
   *
   * `anchor` and `project` still refuse. Identity is rewritten through
   * identity_update rather than deleted — an agent with no SOUL.md is not a
   * corrected agent — and a project is where work happens rather than a claim
   * that could be wrong.
   */
  router.delete("/memory/:name", async (req, res) => {
    const name = String(req.params.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });

    const node = await getNode(name);
    if (!node) return res.status(404).json({ error: `Nothing in memory is called "${name}"` });
    if (node.type === "anchor" || node.type === "project") {
      return res.status(400).json({
        error:
          node.type === "anchor"
            ? `"${name}" is one of the agent's identity documents — rewrite it rather than deleting it.`
            : `"${name}" is a project, not a belief about the world.`,
      });
    }
    await removeNode(name);
    res.json({ ok: true, forgotten: name, type: node.type });
  });

  /**
   * The graph as a picture rather than a list.
   *
   * The memory page shows what the agent knows as rows, which answers "does it
   * know X" and not "how is any of this connected" — and connection is what a
   * graph is for. An unattended loop writing into it makes that the more useful
   * question: a cluster of nodes nothing links to is a subject it read about
   * and never related to anything else.
   */
  router.get("/memory/graph", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 10), 500);
    const type = typeof req.query.type === "string" ? (req.query.type as NodeType) : undefined;
    res.json(await graphSnapshot(limit, type));
  });

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
