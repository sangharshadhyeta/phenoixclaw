import { nodesByType, upsertNode, type NodeRow } from "./graph.js";

/**
 * What the agent knows about the person it works for. Ports BirdClaw's
 * `memory/user_knowledge.py`.
 *
 * BirdClaw keeps this as a markdown file of bulleted sections. Here they are
 * `user` nodes sub-typed by the `category` column — which is what that column
 * was added for, and until now only the tool cache used it, so the schema
 * described a feature that was not there.
 *
 * Nodes rather than a file for the same reason identity moved into the graph:
 * a fact learned in a task session should be known by a chat session, and a
 * file is only read by whoever happens to have the right cwd. It also means
 * `graph_recall` finds these like anything else, and corroboration applies —
 * something the user says twice is held more firmly than something said once.
 *
 * This is private. It is notes about one person, so it loads only for that
 * person's own conversations, the same rule PrimaryUser.md and MEMORY.md
 * follow in sdk-client.ts. A teammate messaging the bot must not get an agent
 * carrying a list of its owner's preferences.
 */

export const USER_CATEGORIES = ["facts", "preferences", "interests", "behaviors"] as const;
export type UserCategory = (typeof USER_CATEGORIES)[number];

/** Bullets kept in the prompt. BirdClaw's `_EXCERPT_ITEMS`. */
const EXCERPT_ITEMS = 12;
/** Of those, how many may be behaviours. BirdClaw reserves the same six. */
const BEHAVIOUR_SLOTS = 6;

const normalise = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Record something about the user.
 *
 * Deduplicated by containment rather than by exact match, as BirdClaw does:
 * "prefers dark mode" and "the user prefers dark mode" are the same fact, and
 * a store that accumulates both says the same thing twice in a prompt that has
 * room for twelve things. A near-duplicate corroborates the existing node
 * instead — same text, one more observation, higher confidence.
 */
export async function rememberUser(fact: string, category: UserCategory = "facts"): Promise<string> {
  const text = fact.trim();
  if (!text) return "Nothing to remember.";

  const key = normalise(text);
  for (const existing of await nodesByType("user", 500)) {
    const known = normalise(existing.summary);
    if (known.includes(key) || key.includes(known)) {
      // Re-observed: worth strengthening, not worth storing twice.
      await upsertNode(existing.name, "user", existing.summary, undefined, { category, source: "primary-user" });
      return `Already known: "${existing.summary}"`;
    }
  }

  // Named by content so the same fact arriving twice lands on the same node
  // even across sessions — the graph's own identity rule, applied here.
  await upsertNode(`user:${key.slice(0, 80)}`, "user", text, undefined, { category, source: "primary-user" });
  return `Remembered (${category}): "${text}"`;
}

/** Everything known about the user, newest first. */
export const allUserKnowledge = (): Promise<NodeRow[]> => nodesByType("user", 500);

/**
 * A compact block for the system prompt.
 *
 * Behaviours come first and get reserved room. They are interaction rules —
 * "don't pad answers", "always show the command before running it" — and a
 * rule that silently drops out once the agent has learned thirteen other
 * things about you is worse than one that was never recorded, because you
 * stopped repeating it.
 */
export async function userKnowledgeExcerpt(maxItems = EXCERPT_ITEMS): Promise<string> {
  const rows = await allUserKnowledge();
  if (!rows.length) return "";

  const behaviours = rows.filter((r) => r.category === "behaviors");
  const others = rows.filter((r) => r.category !== "behaviors");

  const keptBehaviours = behaviours.slice(0, BEHAVIOUR_SLOTS);
  const keptOthers = others.slice(0, Math.max(0, maxItems - keptBehaviours.length));

  const parts: string[] = [];
  if (keptBehaviours.length) {
    parts.push("Interaction rules (always follow):\n" + keptBehaviours.map((r) => `- ${r.summary}`).join("\n"));
  }
  if (keptOthers.length) {
    parts.push("About the user:\n" + keptOthers.map((r) => `- ${r.summary}`).join("\n"));
  }
  return parts.join("\n\n");
}
