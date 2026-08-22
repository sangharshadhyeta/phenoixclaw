import { Type } from "typebox";
import { neighbors, searchNodesSemantic, upsertEdge, upsertNode, type NodeType } from "../graph.js";

const NODE_TYPES = ["user", "project", "concept", "fact", "skill"] as const;

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
export function graphTools() {
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
        await upsertNode(name, p.type as NodeType, String(p.summary ?? "").trim());
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

    pi.registerTool({
      name: "graph_recall",
      label: "Recall",
      description:
        "Search long-term memory for something previously saved with graph_remember. Returns matches and " +
        "what they're directly connected to.",
      promptSnippet: "graph_recall — search long-term memory",
      parameters: Type.Object({
        query: Type.String({ description: "What to search for." }),
        limit: Type.Optional(Type.Number({ description: "Max results. Defaults to 5." })),
      }),
      async execute(_id: string, p: any) {
        const query = String(p.query ?? "").trim();
        if (!query) throw new Error("Nothing to search for.");
        const limit = typeof p.limit === "number" && p.limit > 0 ? p.limit : 5;
        const hits = await searchNodesSemantic(query, limit);
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
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
      },
    });
  };
}
