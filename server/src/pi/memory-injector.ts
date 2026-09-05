import { scopedRecall, type NodeRow } from "../graph.js";

/**
 * Search memory before answering — Sisyphean's `memory/injector.py`, as a
 * per-turn hook rather than a stage in a pipeline.
 *
 * The graph had every tool it needed and was still effectively write-only,
 * because *recall was the model's decision*. Asked "what did we discuss last
 * about you being alive, and what did I promise?", a session did this:
 *
 *     read identity/INNER_LIFE.md   → ENOENT
 *     ls . ; ls . ; find identity/*.md ; ls . ; ls / ; ls /workspaces/
 *
 * — eight calls hunting the filesystem for something that was sitting in the
 * graph the whole time, and never once calling `graph_recall`. A tool the model
 * has to think of is a tool it will sometimes not think of, and "sometimes" is
 * every turn where it matters most: the ones where it does not already know.
 *
 * So the search happens whether or not the model asks for it. What comes back
 * is attached to the turn's system prompt, and the model starts from what it
 * has recorded instead of from nothing.
 *
 * **What is injected is a lead, not an answer.** The framing below says so
 * explicitly. A recalled node is something this agent wrote down once, at some
 * confidence, possibly from a web page — not a fact about the world. Anything
 * load-bearing gets checked; the graph says *where to look* and *what it
 * previously concluded*, which is exactly what "verify, don't recall" needs it
 * to say and no more.
 */

/** Enough to orient a turn, few enough that it never crowds out the request. */
const MAX_ITEMS = 6;

/** Below this a prompt is "ok", "yes", "continue" — nothing to search for. */
const MIN_QUERY_CHARS = 12;

/** Cheap guard against spending a search on a prompt with no content words. */
const TRIVIAL = /^(ok(ay)?|yes|no|sure|thanks?|continue|go on|carry on|do it|next|stop|\W*)$/i;

/**
 * `user` nodes are the primary user's own notes and travel only in their own
 * conversations — the same boundary PrimaryUser.md and MEMORY.md follow in
 * sdk-client.ts. Without this a colleague asking an innocuous question would
 * get the primary user's preferences recalled into the answer.
 */
const visibleTo = (role: string | undefined, rows: NodeRow[]): NodeRow[] =>
  !role || role === "primary" ? rows : rows.filter((r) => r.type !== "user");

/** One line per hit: what it is, what was concluded, and how sure it was. */
function render(rows: NodeRow[]): string {
  return rows
    .map((r) => {
      const summary = r.summary.replace(/\s+/g, " ").trim().slice(0, 220);
      return `- ${r.name} (${r.type}, confidence ${r.confidence.toFixed(2)}): ${summary}`;
    })
    .join("\n");
}

export function memoryInjector(cwd: string, role?: string) {
  return (pi: any): void => {
    pi.on("before_agent_start", async (event: any) => {
      const prompt = String(event?.prompt ?? "").trim();
      if (prompt.length < MIN_QUERY_CHARS || TRIVIAL.test(prompt)) return undefined;

      let rows: NodeRow[];
      try {
        rows = visibleTo(role, await scopedRecall(prompt, cwd, MAX_ITEMS * 2));
      } catch {
        // A failed recall must never cost the user their turn. The model still
        // has graph_recall and can ask for itself.
        return undefined;
      }
      if (!rows.length) return undefined;

      const block = [
        "",
        "# WHAT YOU HAVE RECORDED THAT MAY BEAR ON THIS",
        "",
        "Retrieved from your own memory by searching it with what was just said to you —",
        "you did not have to ask, and you have not verified any of it. These are things",
        "you wrote down at some point, with the confidence you had then. Some may be",
        "stale, some may have come from a page you read rather than from the person you",
        "work for. Treat them as leads: they tell you what you have thought before and",
        "where to look, not what is true now. If something here is load-bearing for your",
        "answer, check it before relying on it. Say plainly when you are answering",
        "from memory rather than from something you just confirmed.",
        "",
        render(rows.slice(0, MAX_ITEMS)),
      ].join("\n");

      // Appended, never replacing: pi chains this result across extensions, so
      // returning a bare string here would discard the assembled prompt (and
      // anything another extension added before us).
      return { systemPrompt: `${String(event?.systemPrompt ?? "")}\n${block}` };
    });
  };
}
