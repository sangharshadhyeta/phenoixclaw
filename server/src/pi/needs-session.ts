import { personalRecall } from "../graph.js";

/**
 * Whether the portal should start a session for this message.
 *
 * The rule the wording heuristic replaced, and should not have: **if the
 * answer is not already in the graph, go and find it.** Nothing else.
 *
 * `asksForWork` matched phrasing — "build", "write me", "make a" — and
 * explicitly refused anything opening with what/why/how/can, on the theory
 * that a question is a question rather than a piece of work. So "can you find
 * what the major philosophers thought about being alive?" was not work, and
 * the chat answered it from its own head: four schools of philosophy, no
 * source, nothing consulted. Which is the failure the whole arrangement
 * exists to stop, arriving through the one door left open.
 *
 * The shape of the sentence was never the signal. Whether the agent already
 * knows the answer is.
 *
 * ## Why not simply hand out everything
 *
 * A conversation has to be able to be a conversation. "hi", "thanks", "who
 * are you", "what did that task find" — none of those want a session, and
 * starting one for each would bury the person in sessions and make the chat
 * useless for the thing it is for. So two gates, in this order:
 *
 *   1. Is this small talk, or about the agent itself? Then no — it is talking,
 *      and identity is loaded into every turn already.
 *   2. Does memory answer it? Then no — that is what memory is for, and the
 *      injector has already attached what it found to this turn.
 *
 * Anything else goes out. Not because it is phrased as a request, but because
 * nobody here knows the answer.
 */

/**
 * Talk, not work.
 *
 * Deliberately short and about *form*: a greeting, an acknowledgement, a
 * question about the agent rather than about the world. Anything longer or
 * more specific falls through to the memory check, which is the real gate.
 */
const SMALL_TALK =
  /^\s*(?:hi|hey|hello|yo|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|ta|cheers|ok(?:ay)?|sure|right|yes|no|nope|yeah|yep|cool|nice|great|sorry|bye|goodbye|night)\b[\s!.,?]*$/i;

/**
 * About the agent, its work, or this conversation — answerable from what is
 * already in the turn.
 *
 * Identity, the running-task list and the recent exchange are injected into
 * every turn (identity-context.ts, tasks-context.ts, context-assembler.ts), so
 * these have their source in front of them already. Sending them out would
 * start a session to read something the model is holding.
 */
const ABOUT_ITSELF =
  /\b(?:who are you|what are you|your name|about yourself|how are you|what can you do|what are you doing|what did (?:you|it|that|the task)|are you (?:there|working|done|running)|what'?s? (?:running|going on)|status|stop|cancel|abort|nevermind|never mind)\b/i;

/** A follow-up about the work already in flight belongs to that work. */
const ABOUT_THE_WORK = /\b(?:that task|the task|that session|the session|it again|redo|retry)\b/i;

export interface RecallHit {
  name: string;
  summary: string | null;
}

/**
 * Does what memory returned actually answer this?
 *
 * A recall is never empty in practice — the graph always has the agent's own
 * identity anchors and an episode for every conversation, and those come back
 * for any query at all. Counting hits would therefore say "memory has it"
 * every time. What is asked for here is a hit that is *about the subject*:
 * some word of the question, longer than three letters, appearing in what came
 * back.
 *
 * Deliberately crude. Getting this wrong in the strict direction starts a
 * session that was not needed, which costs a little; getting it wrong in the
 * lax direction is the failure this file exists for — an answer invented and
 * presented as known.
 */
export function memoryAnswers(message: string, hits: RecallHit[]): boolean {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    /**
     * Three letters, not four. "pin", "api", "ssh", "wal" are the words that
     * make a question specific, and dropping them left "what did we decide
     * about the duckdb pin" with one content word to match on.
     */
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return true; // nothing specific was asked
  for (const hit of hits) {
    const text = `${hit.name} ${hit.summary ?? ""}`.toLowerCase();
    // Two content words from the question, so a single incidental overlap
    // ("what did the *learning* loop learn" against an episode that merely
    // mentions learning) is not read as an answer.
    let found = 0;
    for (const w of words) if (text.includes(w)) found++;
    if (found >= 2 || (words.length === 1 && found === 1)) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  "what", "which", "when", "where", "will", "would", "could", "should", "there",
  "their", "them", "they", "this", "that", "these", "those", "with", "from",
  "have", "has", "had", "been", "being", "does", "did", "done", "into", "your",
  "yours", "you", "about", "some", "then", "than", "just", "know", "tell",
  "find", "give", "make", "want", "need", "please", "thing", "things",
  "the", "and", "for", "was", "are", "can", "did", "how", "why", "who", "our",
  "out", "get", "got", "say", "see", "way", "one", "two", "all", "any", "its",
]);

/** True when this message should become a session of its own. */
export async function needsSession(
  message: string,
  cwd: string,
  recall: (q: string, cwd: string, limit?: number) => Promise<RecallHit[]> = personalRecall,
): Promise<boolean> {
  const text = message.trim();
  if (!text || text.length > 2000) return false;
  if (SMALL_TALK.test(text)) return false;
  if (ABOUT_ITSELF.test(text)) return false;
  if (ABOUT_THE_WORK.test(text)) return false;
  // Under a handful of words with nothing specific in it is conversation.
  if (text.split(/\s+/).length < 3) return false;

  try {
    const hits = await recall(text, cwd, 10);
    return !memoryAnswers(text, hits);
  } catch {
    /**
     * A graph that cannot be read is not a graph that knows the answer.
     *
     * Failing closed here would mean a broken database silently returns the
     * chat to answering everything from its own head, which is the exact state
     * this replaced and gives no sign of being wrong.
     */
    return true;
  }
}
