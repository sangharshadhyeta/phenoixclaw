/**
 * Content pruning — drop the low-information parts of a block before it goes
 * into a prompt. Ports BirdClaw's `llm/pruner.py` (`keyword_prune`).
 *
 * Only the keyword tier. BirdClaw's second tier asks a small model to extract
 * the relevant sentences, and is reserved there for text where keyword overlap
 * is noisy — chiefly HTML-stripped web pages, which nothing here fetches yet.
 * A second model call per recall is a real cost against a single local server,
 * so it is left until there is content that actually needs it.
 *
 * The rule that makes this worth having: chunks are *selected* by score but
 * *emitted in their original order*. Reordering by relevance would hand the
 * model a jumble whose sentences no longer follow from each other, which reads
 * as less coherent than the untrimmed original even though every line in it is
 * relevant.
 */

/** Below this, trimming costs more in lost context than it saves in tokens. */
const MIN_PRUNE_CHARS = 200;

/**
 * Words too common to say anything about relevance. Scoring keeps them out
 * rather than filtering afterwards: a chunk that shares only "the" and "and"
 * with the query would otherwise outrank one sharing a single rare term.
 */
const STOP = new Set([
  "the", "and", "for", "are", "was", "this", "that", "with", "have",
  "from", "they", "will", "been", "had", "has", "its", "not", "but",
  "can", "all", "one", "you", "your", "our", "their", "also", "more",
]);

const tokenise = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)),
  );

/** Sentences where there are enough of them to be meaningful, otherwise lines. */
function splitChunks(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length > 3) return sentences;
  return text.split("\n").filter((l) => l.trim());
}

/**
 * Keep the parts of `text` that overlap with `goal`, up to `maxChars`.
 *
 * Returns the input untouched when it is already short, and falls back to a
 * plain truncation when there is nothing to score against — a goal of only
 * stop-words, or no goal at all. Never returns empty for non-empty input.
 */
export function keywordPrune(text: string, goal: string, maxChars = 800): string {
  if (!text || text.length <= MIN_PRUNE_CHARS) return text;
  const goalTokens = tokenise(goal ?? "");
  if (!goalTokens.size) return text.slice(0, maxChars);

  const chunks = splitChunks(text);
  const scored = chunks.map((chunk, index) => {
    const tokens = tokenise(chunk);
    let score = 0;
    for (const t of goalTokens) if (tokens.has(t)) score++;
    return { score, index, chunk };
  });

  /**
   * Only chunks that actually matched. BirdClaw scores every chunk and then
   * fills the budget from the top down, which means that once the relevant
   * text runs out it keeps going into text that matched nothing — the reader
   * gets padding that looks like an answer. Pruning to a budget and pruning
   * to relevance are different jobs; this does the second, and the budget is
   * a ceiling rather than a target.
   */
  const relevant = scored.filter((c) => c.score > 0);
  if (!relevant.length) return text.slice(0, maxChars);

  // Highest scoring first; ties broken by position, so an earlier chunk wins
  // over a later one that tells you the same thing.
  relevant.sort((a, b) => b.score - a.score || a.index - b.index);

  const keep = new Set<number>();
  let budget = maxChars;
  for (const { index, chunk } of relevant) {
    const cost = chunk.length + 1;
    // Checked before adding, not after. BirdClaw adds first and subtracts
    // afterwards, so the result overshoots `max_chars` by up to one chunk —
    // survivable there, and not something to reproduce in a budget that
    // exists to keep a never-ending session inside its context window. A
    // chunk that does not fit is skipped rather than ending the loop, so a
    // shorter lower-scoring one can still use the remaining room.
    if (keep.size && cost > budget) continue;
    keep.add(index);
    budget -= cost;
  }

  const result = chunks.filter((_, i) => keep.has(i)).join("\n").trim();
  return result || text.slice(0, maxChars);
}
