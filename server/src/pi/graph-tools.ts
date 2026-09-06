import { Type } from "typebox";
import { keywordPrune } from "../prune.js";
import { recordAudit } from "../db.js";
import {
  getNode,
  neighbors,
  recentNodes,
  removeNode,
  scopedRecall,
  scopeToProject,
  upsertEdge,
  upsertNode,
  type NodeType,
} from "../graph.js";

/** What one recall may put into the prompt. Generous enough for several nodes, bounded enough to stay bounded. */
const RECALL_CHAR_CAP = 2000;

const NODE_TYPES = ["user", "project", "concept", "fact", "skill"] as const;

/** A collision-safe key for a log entry (episode/workspace_note) — these are appended, never upserted onto one another. */
const logKey = (kind: string) => `${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

/**
 * Durable fact memory, backed by the knowledge graph in graph.ts.
 *
 * This is the structured-extraction half of the graph: rather than a separate
 * regex/NER pass parsing conversation text after the fact, the model itself
 * decides what's worth keeping and calls `graph_remember` with a
 * schema-validated shape. Registered for every session — remembering and
 * recalling facts is a normal-conversation thing, the same role Birdclaw's
 * `save_memory` played, not something limited to a routine.
 */
/**
 * `reflective` adds the tools that look back over memory as a whole rather
 * than answering a question in front of you — see sdk-client.ts for why a
 * session working in somebody's repository does not get them.
 */
export function graphTools(cwd: string, reflective = true, sessionId?: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "graph_remember",
      label: "Remember",
      description:
        "Save or update a durable fact in long-term memory: something worth knowing next session, not just " +
        "this conversation. Re-saving something already known corroborates it (raises confidence) rather than " +
        "duplicating it. Optionally wire it to related facts in the same call.",
      promptSnippet: "graph_remember — save a durable fact, optionally linked to related ones",
      parameters: Type.Object({
        name: Type.String({ description: "Short, stable name for the thing — becomes its identity, so keep it consistent across calls (e.g. always 'phoenixclaw', not sometimes 'the phoenixclaw project')." }),
        type: Type.Union(
          NODE_TYPES.map((t) => Type.Literal(t)),
          { description: "user: about the person. project: something being worked on. concept: an idea or technology. skill: a capability. fact: anything else." },
        ),
        summary: Type.String({ description: "What's worth knowing about it, in a sentence or two." }),
        relations: Type.Optional(
          Type.Array(
            Type.Object({
              relation: Type.String({ description: "A short verb phrase, e.g. 'works_on', 'depends_on', 'prefers'." }),
              target: Type.String({ description: "Name of the related thing. Created automatically if it doesn't exist yet." }),
            }),
            { description: "Other things this connects to, if any." },
          ),
        ),
      }),
      async execute(_id: string, p: any) {
        const name = String(p.name ?? "").trim();
        if (!name) throw new Error("Nothing to remember — no name given.");
        // "the agent concluded this" — distinguishable later from "the person
        // said it" and from "a page said it", which is the whole point of
        // keeping sources at all.
        await upsertNode(name, p.type as NodeType, String(p.summary ?? "").trim(), undefined, {
          source: "agent-conclusion",
        });
        for (const r of Array.isArray(p.relations) ? p.relations : []) {
          const relation = String(r?.relation ?? "").trim();
          const target = String(r?.target ?? "").trim();
          if (relation && target) await upsertEdge(name, relation, target);
        }
        return {
          content: [{ type: "text" as const, text: `Remembered "${name}".` }],
          details: {},
        };
      },
    });

    /**
     * The correction path.
     *
     * Without one, a wrong belief could only be removed by a person editing
     * the database, which does not scale past the first few — and the agent
     * would go on asserting it in the meantime, because confidence only ever
     * rose. Decay (decayStaleBeliefs) lets a mistake fade quietly; this lets
     * the agent retract one the moment it *notices*, which is both faster and
     * the only response that makes sense when it can see the contradiction.
     */
    pi.registerTool({
      name: "graph_forget",
      label: "Correct something you believed",
      description:
        "Remove something from your memory that you have found to be wrong: a fact that has since " +
        "changed, something you recorded from a page that turned out to be untrue, a claim you now " +
        "have better evidence against. Use it as soon as you notice the contradiction rather than " +
        "answering around it, and record what is actually true with graph_remember afterwards so " +
        "the correction itself is kept. Your identity, what you know about the person you work for, " +
        "and project anchors cannot be removed this way — those are corrected by rewriting them.",
      promptSnippet: "graph_forget — remove a belief you have found to be wrong",
      parameters: Type.Object({
        name: Type.String({ description: "The exact name of the node, as graph_recall shows it." }),
        why: Type.String({ description: "What makes it wrong. Kept in the audit log." }),
      }),
      async execute(_id: string, p: any) {
        const name = String(p?.name ?? "").trim();
        const said = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
        if (!name) return said("Nothing named to forget.");

        const node = await getNode(name);
        if (!node) return said(`Nothing in your memory is called "${name}".`);

        // anchor is identity, user is what the person told you about
        // themselves, project is where work happens. None of them is a claim
        // about the world that could turn out false, and each has its own edit
        // path — deleting one here would be a way round those, not a correction.
        if (["anchor", "user", "project"].includes(node.type)) {
          const instead =
            node.type === "anchor"
              ? "Use identity_update to rewrite it."
              : node.type === "user"
                ? "Use remember_user to record what is actually true."
                : "A project is where work happens, not a claim about the world.";
          return said(`"${name}" is a ${node.type}, not a belief that can be wrong. ${instead}`);
        }

        await removeNode(name);
        void recordAudit({
          kind: "graph-forget",
          tool: "graph_forget",
          subject: name,
          reason: String(p?.why ?? "").slice(0, 500),
          sessionId,
        });
        return said(`Forgotten: "${name}". Record what is true instead, so the correction is kept.`);
      },
    });

    pi.registerTool({
      name: "graph_recall",
      label: "Recall",
      description:
        "Search long-term memory for something previously saved with graph_remember, graph_episode or " +
        "workspace_note. Returns matches and what they're directly connected to. Facts about you and your " +
        "skills are visible everywhere; anything scoped to a specific project (episodes, workspace notes) " +
        "only surfaces while working in that project.",
      promptSnippet: "graph_recall — search long-term memory",
      parameters: Type.Object({
        query: Type.String({ description: "What to search for." }),
        limit: Type.Optional(Type.Number({ description: "Max results. Defaults to 5." })),
      }),
      async execute(_id: string, p: any) {
        const query = String(p.query ?? "").trim();
        if (!query) throw new Error("Nothing to search for.");
        const limit = typeof p.limit === "number" && p.limit > 0 ? p.limit : 5;
        const hits = await scopedRecall(query, cwd, limit);
        if (!hits.length) {
          return { content: [{ type: "text" as const, text: "Nothing found." }], details: {} };
        }
        const lines: string[] = [];
        for (const hit of hits) {
          lines.push(`${hit.name} (${hit.type}): ${hit.summary}`);
          const nbrs = await neighbors(hit.name);
          for (const n of nbrs.slice(0, 5)) {
            lines.push(
              n.direction === "out"
                ? `  — ${hit.name} ${n.relation} ${n.name}`
                : `  — ${n.name} ${n.relation} ${hit.name}`,
            );
          }
        }
        /**
         * Pruned against the query before it goes back, the same way
         * BirdClaw's `retrieval.py` prunes rendered graph context.
         *
         * A recall returns whole node summaries plus five relations each, and
         * a node's summary is written to be complete rather than to answer
         * this particular question. In an ordinary conversation that is
         * affordable; in the learning loop, which recalls on every iteration
         * and never ends, it is the thing that fills the context window. The
         * relation lines usually survive — they are short and carry the query
         * terms — while a long summary gets cut to the part that was asked
         * about.
         */
        const rendered = keywordPrune(lines.join("\n"), query, RECALL_CHAR_CAP);
        return { content: [{ type: "text" as const, text: rendered }], details: {} };
      },
    });

    if (reflective) pi.registerTool({
      name: "graph_reflect",
      label: "Reflect",
      description:
        "See the most recently touched things in long-term memory — not a search, just what's changed " +
        "lately. Use it to look for patterns, contradictions or connections across recent facts, and " +
        "capture anything worth keeping with graph_remember.",
      promptSnippet: "graph_reflect — see what's changed lately in long-term memory",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "How many recent things to see. Defaults to 20." })),
      }),
      async execute(_id: string, p: any) {
        const limit = typeof p.limit === "number" && p.limit > 0 ? p.limit : 20;
        const hits = await recentNodes(limit);
        if (!hits.length) {
          return { content: [{ type: "text" as const, text: "Nothing in memory yet." }], details: {} };
        }
        const lines = hits.map((n) => `- ${n.name} (${n.type}): ${n.summary}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
      },
    });

    pi.registerTool({
      name: "graph_episode",
      label: "Log episode",
      description:
        "Log a short note about this turn or session worth having later — what happened, what was decided, " +
        "what came of it. Scoped to this project: it won't surface as if relevant while working somewhere else.",
      promptSnippet: "graph_episode — log a turn-history note, scoped to this project",
      parameters: Type.Object({
        summary: Type.String({ description: "What happened, in a sentence or two." }),
      }),
      async execute(_id: string, p: any) {
        const summary = String(p.summary ?? "").trim();
        if (!summary) throw new Error("Nothing to log.");
        const name = logKey("episode");
        await upsertNode(name, "episode", summary);
        await scopeToProject(name, cwd);
        return { content: [{ type: "text" as const, text: "Logged." }], details: {} };
      },
    });

    pi.registerTool({
      name: "workspace_note",
      label: "Note for this workspace",
      description:
        "Append a note to this project's own log: a completed task, a decision and why, something worth " +
        "knowing the next time work happens here. Scoped to this project only.",
      promptSnippet: "workspace_note — append to this project's log",
      parameters: Type.Object({
        summary: Type.String({ description: "What's worth knowing, in a sentence or two." }),
      }),
      async execute(_id: string, p: any) {
        const summary = String(p.summary ?? "").trim();
        if (!summary) throw new Error("Nothing to note.");
        const name = logKey("workspace_note");
        await upsertNode(name, "workspace_note", summary);
        await scopeToProject(name, cwd);
        return { content: [{ type: "text" as const, text: "Noted." }], details: {} };
      },
    });
  };
}
