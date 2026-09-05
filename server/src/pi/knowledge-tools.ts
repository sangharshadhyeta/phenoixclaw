import { Type } from "typebox";
import { ingestText } from "../ingest.js";
import { recallPage } from "../page-store.js";
import { findSymbol } from "../code-index.js";
import { localModelConfigured } from "../llm.js";

/**
 * Two tools that answer questions the agent would otherwise spend several
 * turns on: "read this into what I know", and "where is this defined".
 *
 * `graph_ingest` ports BirdClaw's `memory/ingest.py` — the bridge between
 * having read something and knowing it. Without it a fetched page sits in the
 * page store as text: recall finds the words, but nothing in the graph
 * connects the fact inside to anything else.
 *
 * `find_symbol` ports `tools/code_index.py`, shape rather than mechanism —
 * see code-index.ts for why a regex replaces the AST here.
 */

const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function knowledgeTools(cwd: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "graph_ingest",
      label: "Read into memory",
      description:
        "Read a document or a page you have already fetched into long-term memory: it is broken " +
        "into facts, the things it names are extracted, and both go into the graph where " +
        "`graph_recall` will find them later. Give a `url` you fetched earlier, or `text` " +
        "directly. Use it when something is worth knowing rather than just worth reading now — " +
        "it takes a little while, and the result is that you will still know this next week.",
      promptSnippet: "graph_ingest — read a page or document into long-term memory",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ description: "A URL you fetched earlier with web_fetch." })),
        text: Type.Optional(Type.String({ description: "Text to read in directly, if you have it to hand." })),
        source: Type.Optional(Type.String({ description: "Where this came from, for attribution." })),
      }),
      async execute(_id: string, p: any) {
        if (!localModelConfigured()) {
          return say(
            "Reading into memory needs a local model, and none is configured on this portal " +
              "(LLAMA_BASE_URL). Use graph_remember to record what matters by hand instead.",
          );
        }
        const url = String(p.url ?? "").trim();
        let text = String(p.text ?? "").trim();
        let source = String(p.source ?? "").trim() || url || "text";

        if (!text && url) {
          const page = await recallPage(url);
          if (!page) {
            return say(
              `Nothing stored for ${url} — fetch it with web_fetch first, then read it in. ` +
                "Stored pages expire after a day.",
            );
          }
          text = page;
          source = url;
        }
        if (!text) throw new Error("Give a url you have fetched, or text to read in.");

        const r = await ingestText(text, source);
        if (r.skipped) return say(`Nothing read in: ${r.skipped}`);
        return say(
          `Read ${source} into memory: ${r.propositions} facts from ${r.chunks} chunk(s), ` +
            `${r.entities} things named and ${r.relations} connections between them. ` +
            "Recorded as extracted rather than concluded, so it carries less weight than " +
            "something you worked out yourself — recall will still find it.",
        );
      },
    });

    pi.registerTool({
      name: "find_symbol",
      label: "Find definition",
      description:
        "Find where a function, class, type or constant is defined in this workspace. Faster and " +
        "more exact than grepping for the name, which also matches every call. Returns the file " +
        "and line of each definition.",
      promptSnippet: "find_symbol — find where something is defined",
      parameters: Type.Object({
        name: Type.String({ description: "The exact symbol name." }),
      }),
      async execute(_id: string, p: any) {
        const name = String(p.name ?? "").trim();
        const hits = findSymbol(name, cwd);
        if (!hits.length) {
          return say(
            `No definition of "${name}" found here. It may be imported from a dependency, or ` +
              "spelled differently — grep for it if you expected it to be local.",
          );
        }
        return say(hits.map((h) => `${h.file}:${h.line}  (${h.kind})  ${h.text}`).join("\n"));
      },
    });
  };
}
