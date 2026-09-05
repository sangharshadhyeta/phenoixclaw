import { nodesByType, upsertNode, type NodeRow } from "./graph.js";

/**
 * What the agent has concluded about itself — as accumulated conclusions in
 * the graph, not one document it rewrites.
 *
 * SELF_CONCEPT.md is a **template**: what a new agent starts from, and the
 * human-readable mirror of where it began. The operative self-concept is here,
 * as separate `concept` nodes categorised `self`, one per conclusion.
 *
 * The monolith failed in a specific and instructive way. Early on, with an
 * empty self-concept and nothing else to pursue, the learning loop investigated
 * the only thing available — its own harness — and then wrote "I am an
 * investigator of systems" into the document. From that point every iteration
 * read it during ORIENT and correctly concluded it should investigate systems.
 * A single sentence written during an aimless hour had become identity, and no
 * amount of instruction downstream could outvote it, because identity is read
 * first.
 *
 * Separate conclusions do not fail that way:
 *
 * - Each carries its own confidence, so one written on a thin day sits below
 *   one the agent has re-reached a dozen times.
 * - Corroboration is per claim. Re-concluding something strengthens that
 *   claim rather than rewriting the whole account around it.
 * - A wrong one can be removed on its own, by `removeNode`, without asking
 *   the agent to restate everything it thinks about itself.
 * - The prompt shows the best-established few rather than everything, so a
 *   passing thought does not get equal billing with a settled conviction.
 */

/** The category that marks a `concept` node as a conclusion about the agent itself. */
const SELF = "self";

/** How many make it into the prompt. Enough to be a self, few enough to stay one. */
const EXCERPT_ITEMS = 8;

const normalise = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Everything it has concluded about itself, strongest first. */
export async function selfConclusions(): Promise<NodeRow[]> {
  const rows = await nodesByType("concept", 500);
  return rows
    .filter((r) => r.category === SELF)
    .sort((a, b) => b.confidence - a.confidence || b.observations - a.observations);
}

/**
 * Record a conclusion about itself.
 *
 * Deduplicated by containment, as user knowledge is: reaching the same
 * conclusion in different words should strengthen it, not file it twice and
 * then spend two of eight prompt slots saying one thing.
 */
export async function concludeAboutSelf(claim: string): Promise<string> {
  const text = claim.trim();
  if (!text) return "Nothing to conclude.";

  const key = normalise(text);
  for (const existing of await selfConclusions()) {
    const known = normalise(existing.summary);
    if (known.includes(key) || key.includes(known)) {
      await upsertNode(existing.name, "concept", existing.summary, undefined, { category: SELF });
      return `You had already concluded that: "${existing.summary}"`;
    }
  }
  await upsertNode(`self:${key.slice(0, 80)}`, "concept", text, undefined, { category: SELF });
  return `Recorded: "${text}"`;
}

/**
 * The block that goes into the system prompt.
 *
 * Empty until something has actually been concluded, and deliberately so.
 *
 * This used to fall back to SELF_CONCEPT.md, on the reasoning that the
 * template gives a new agent something to be before it has concluded
 * anything. That reasoning does not survive reading the template
 * (agent-setup.ts): it contains no conclusions. It is a maintenance sheet —
 * "this is your living self-model, and you maintain it", "write in first
 * person", "use `##` section headers, and skip ones you have nothing to say
 * under yet". Served under this block's heading, every one of those becomes
 * something the agent is told it concluded about itself, which is precisely
 * the kind of sentence this module exists to keep out of its identity.
 *
 * An agent that has concluded nothing has concluded nothing. Saying so by
 * saying nothing is honest, and the instruction to go and conclude something
 * lives where it belongs — in the self-reflection routine's PHASE 5, which
 * names `self_review` and `self_conclude` directly.
 */
export async function selfConceptExcerpt(): Promise<string> {
  const rows = await selfConclusions();
  return rows.slice(0, EXCERPT_ITEMS).map((r) => `- ${r.summary}`).join("\n");
}
