import { complete, localModelConfigured, parseJsonArray } from "./llm.js";
import { keywordPrune } from "./prune.js";
import { upsertEdge, upsertNode, type NodeType } from "./graph.js";

/**
 * Turning what was read into what is known. Ports BirdClaw's
 * `memory/ingest.py`.
 *
 * Without this the agent can fetch a page, keep it in the page store, and be
 * no wiser — recall would find the page's *text*, but nothing in the graph
 * would connect it to anything, so the fact inside it stays a paragraph rather
 * than becoming something the agent knows. Ingest is the bridge.
 *
 * Two passes, which is BirdClaw's design and worth keeping. Propositions
 * first: atomic, standalone, pronouns already resolved. Entities from the
 * propositions rather than the raw text, because by then the signal is dense
 * and unambiguous — a second pass over cleaner input beats one pass over
 * messy input, and against a local model the extra call costs only time.
 *
 * BirdClaw drives both passes with forced tool calls. This asks for JSON and
 * takes the outermost array (see llm.ts): pi's tool interface belongs to the
 * agent's own sessions, and reaching into it from the portal to run a
 * background extraction would tangle two very different things.
 */

/** Long enough to hold an idea, short enough that a pass stays sharp. BirdClaw uses 500. */
const CHUNK_CHARS = 500;
/** A page yields plenty; past this the returns fall off and the latency does not. */
const MAX_CHUNKS = 6;

const PROPOSITION_SYSTEM =
  "Break the text into atomic propositions: standalone factual statements, each understandable " +
  "on its own with no pronouns left dangling. Keep only what the text actually asserts — never " +
  "add, infer or embellish. Reply with a JSON array of strings and nothing else.";

const ENTITY_SYSTEM =
  "Extract the named entities and their relationships from these facts. Reply with a JSON array " +
  'and nothing else, each item {"name": string, "type": string, "summary": string, ' +
  '"relations": [{"relation": string, "target": string}]}. Use these types only: person, org, ' +
  "place, concept, file, function, class, module, tool, fact. Never invent a relationship the " +
  "facts do not state.";

/**
 * BirdClaw's entity vocabulary mapped onto this graph's node types.
 *
 * Its extraction prompt names code entities (FILE, FUNCTION, CLASS, MODULE)
 * that have no equivalent here, and inventing four node types for them would
 * put schema in the graph to satisfy a prompt rather than a need. They land as
 * `concept`, which is what they are to a knowledge graph: a named thing the
 * agent can hold an opinion about.
 */
const TYPE_MAP: Record<string, NodeType> = {
  person: "user",
  org: "concept",
  place: "concept",
  concept: "concept",
  file: "concept",
  function: "concept",
  class: "concept",
  module: "concept",
  tool: "skill",
  fact: "fact",
};

export interface IngestResult {
  chunks: number;
  propositions: number;
  entities: number;
  relations: number;
  skipped?: string;
}

/** Paragraphs, packed up to CHUNK_CHARS so a short one is not its own pass. */
function chunk(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > CHUNK_CHARS) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, MAX_CHUNKS);
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Read `text` into the graph, attributed to `source`.
 *
 * Every node it writes carries a lower confidence than something the agent
 * concluded itself, and deliberately: this was extracted by a second model
 * from someone else's prose, which is two removes from a fact the agent has
 * reason to believe. Corroboration will raise it if the same thing turns up
 * again, which is the right way for an extracted claim to earn standing.
 */
export async function ingestText(text: string, source: string): Promise<IngestResult> {
  const empty: IngestResult = { chunks: 0, propositions: 0, entities: 0, relations: 0 };
  if (!localModelConfigured()) return { ...empty, skipped: "no local model configured" };
  if (!text.trim()) return { ...empty, skipped: "nothing to read" };

  const chunks = chunk(text);
  let propositionCount = 0;
  let entityCount = 0;
  let relationCount = 0;

  for (const piece of chunks) {
    const propsRaw = parseJsonArray(await complete(PROPOSITION_SYSTEM, piece));
    // A chunk the model could not decompose is still worth one pass as itself
    // — BirdClaw's fallback, and it keeps a failed call from losing the text.
    const propositions = (propsRaw ?? [piece]).map(asString).filter(Boolean);
    if (!propositions.length) continue;
    propositionCount += propositions.length;

    const bullets = propositions.map((p) => `- ${p}`).join("\n");
    const entities = parseJsonArray(await complete(`${ENTITY_SYSTEM} Source: ${source}`, bullets)) ?? [];

    for (const raw of entities) {
      const e = raw as Record<string, unknown>;
      const name = asString(e.name);
      if (!name) continue;
      const type = TYPE_MAP[asString(e.type).toLowerCase()] ?? "concept";
      const summary = asString(e.summary) || name;
      await upsertNode(name, type, summary, 0.4);
      entityCount++;

      for (const rel of Array.isArray(e.relations) ? e.relations : []) {
        const r = rel as Record<string, unknown>;
        const target = asString(r.target);
        const relation = asString(r.relation) || "related_to";
        if (!target) continue;
        // The target may not have been extracted as an entity in its own
        // right. Created thinly rather than dropped: a relation pointing at
        // nothing is worse than a node with only a name.
        await upsertNode(target, "concept", target, 0.3);
        await upsertEdge(name, relation, target);
        relationCount++;
      }
    }
  }

  return { chunks: chunks.length, propositions: propositionCount, entities: entityCount, relations: relationCount };
}

/**
 * The semantic tier of BirdClaw's `condenser.py`: ask the model for the parts
 * of a page that bear on a goal, when keyword overlap is too blunt to tell.
 *
 * Only for text where the goal's vocabulary does not appear verbatim — which
 * is where keyword pruning fails quietly, returning something plausible that
 * happens to be the wrong half. Falls back to keyword pruning on any failure,
 * so the caller always gets usable text.
 */
export async function semanticPrune(text: string, goal: string, maxChars = 2000): Promise<string> {
  const keyword = keywordPrune(text, goal, maxChars);
  if (!localModelConfigured() || text.length <= maxChars) return keyword;

  const out = await complete(
    "Copy out only the sentences from the text that bear on the reader's question. Copy them " +
      "verbatim, in the order they appear, and write nothing of your own — no summary, no " +
      "preamble. If nothing in the text bears on it, reply with nothing.",
    `Question: ${goal}\n\n---\n${text.slice(0, 12000)}`,
    { maxTokens: 2048 },
  );
  const trimmed = (out ?? "").trim();
  return trimmed ? trimmed.slice(0, maxChars) : keyword;
}
