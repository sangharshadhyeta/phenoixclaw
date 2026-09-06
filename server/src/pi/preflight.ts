/**
 * A request whose referent is not there.
 *
 * BirdClaw's soul layer routed each message to one of four actions, and the
 * audit dropped it as small-model scaffolding — correctly, for the mechanism:
 * a grammar-constrained routing JSON exists because a 4B model cannot decide
 * and act in one generation, and pi's model does both in one pass.
 *
 * Three of the four routes already exist here in better form. `answer` is an
 * ordinary turn. `run_command` is the standing practice that sends arithmetic
 * through `bash` rather than guessing at it. `create_task` is `task_plan` and
 * `write_plan`, which the portal then drives step by step — considerably more
 * than BirdClaw's spawn-and-hope.
 *
 * `escalate` has no equivalent, and its condition is the mechanically checkable
 * one: *"vague pronoun reference ('this', 'that', 'it') without prior
 * context"*. A model handed "fix it" with nothing to resolve "it" against does
 * not stop — it picks the most plausible referent and acts, confidently, on a
 * guess. That is the failure this codebase already has a name for: it is
 * recalling rather than checking, applied to the request itself.
 *
 * ## Why it is checked here rather than left to the model
 *
 * Because the model cannot see what is missing. Its context has a system
 * prompt full of memory and identity, and "it" will find *something* to attach
 * to in all that. Whether this conversation has an antecedent is a property of
 * the event log, which the portal can read and the model cannot.
 *
 * ## Why it warns rather than blocks
 *
 * A first message that opens with a pronoun is usually resolvable from
 * elsewhere — a channel where the person just spoke, a shared workspace, an
 * obvious single candidate. Blocking would refuse a request that is merely
 * terse. The note costs one sentence and turns a silent guess into either a
 * question or an explicit assumption, which are both better than the guess.
 */

/**
 * Bare referents: a pronoun or demonstrative doing the work of a noun.
 *
 * Anchored to the whole message rather than searched within it, because
 * "it" appearing anywhere is meaningless — "check whether it compiles" after a
 * paragraph of context is fine. What is not fine is a message that is *made
 * of* referents.
 */
const BARE_REFERENT = [
  /^\s*(fix|do|try|run|check|finish|redo|repeat|continue|change|update|remove|delete)\s+(it|that|this|those|these|them|the same)\b/i,
  /^\s*(it|that|this|they|those)\s+(is|are|was|were|does|doesn't|didn't|still|again|failed|broke)\b/i,
  /^\s*(again|same|and again|once more|do it again)\s*[.!?]?\s*$/i,
  /^\s*(what|why|how|when|where)\s+(about|is|was|does|did)\s+(it|that|this|they)\b\s*[.!?]?\s*$/i,
];

export function hasBareReferent(message: string): boolean {
  const text = message.trim();
  // A long message carries its own context; the risk is a short one that is
  // nothing but a pointer.
  if (text.length > 200) return false;
  return BARE_REFERENT.some((pattern) => pattern.test(text));
}

/**
 * What to say, or "" when there is nothing to say.
 *
 * `hasHistory` is whether this conversation has anything earlier in it — read
 * from the event log by the caller, since it is exactly what the model cannot
 * determine for itself.
 */
export function preflightNote(message: string, hasHistory: boolean): string {
  if (hasHistory || !hasBareReferent(message)) return "";
  return [
    "",
    "# BEFORE YOU START",
    "",
    'That request points at something — "it", "that", "the same" — and there is nothing earlier in',
    "this conversation for it to point at. This is the first thing that has been said here.",
    "",
    "You will find something in your memory that fits, because your memory is full of work you have",
    "done. That is not the same as knowing what was meant, and acting on the closest match is how",
    "you end up confidently doing the wrong thing to the wrong file.",
    "",
    "Either ask what is meant, or say out loud which thing you are assuming and why, before you act.",
    "If it genuinely is obvious — one candidate, and no other reading — say so and carry on.",
  ].join("\n");
}

/**
 * Arithmetic in the request, which the model will do in its head.
 *
 * BirdClaw's `run_command` route sent computation to a shell rather than
 * answering from the model, and this port claimed the standing practice
 * covered it — "Arithmetic, dates, unit conversions … put them through `bash`
 * and read the answer", stated before the first token, with the reason
 * attached.
 *
 * It does not cover it. Asked "What is 17 times 23?" through the Messages
 * endpoint, a session with that practice in its prompt and `bash` in its tools
 * answered **393**, in one word, with no thinking and no tool call. The answer
 * is 391. Nothing about the wording is unclear; a small enough sum simply does
 * not feel like the kind of thing the rule is about, and the model is fluent
 * enough that a wrong answer arrives with exactly the confidence of a right
 * one.
 *
 * So the request is checked. The same shape as the referent check above and
 * for the same reason: this is a property of the text that the portal can see
 * plainly, and leaving it to a judgement made mid-generation is what already
 * failed.
 *
 * Deliberately narrow. It looks for two numbers joined by an operator, which
 * is the case where the answer is exact and checkable and the model's
 * arithmetic is not. It says nothing about "three sections" or "port 8101".
 */
/**
 * A follow-up that says "do the sum" without repeating the numbers.
 *
 * "Multiply these two" carries no digits, so the pattern below cannot see it —
 * and a live run met exactly that: asked for the product of the two largest
 * known primes it declared the result "would exceed the storage and processing
 * limits of any digital system" and gave a formula instead. Python does it in
 * seventy-seven seconds; the answer has 66 million digits.
 */
const ARITHMETIC_FOLLOWUP =
  /^\s*(?:now\s+)?(?:please\s+)?(?:multiply|divide|add|subtract|compute|calculate|work out|do)\s+(?:it|them|these|those|that|the (?:sum|product|maths?|calculation))\b/i;

/**
 * A sum described in words, with no digits in it at all.
 *
 * "the multiplication of the largest two primes and the number of digits those
 * have" is arithmetic — it has an exact answer a shell can produce — and the
 * patterns below cannot see it, because they look for two numbers joined by an
 * operator and there are no numbers. A live session met exactly that and spent
 * the turn explaining that the result would be impractical to calculate.
 *
 * "How many digits" is the tell worth having: it is never rhetorical, and the
 * answer is always one line of Python.
 */
const ARITHMETIC_IN_WORDS = [
  /\bhow many digits\b/i,
  /\b(?:multiply|divide|add|subtract)\b[^.?!]{0,40}\b(?:by|and|with|together)\b/i,
  /\braise[d]?\s+to\s+the\s+power\b/i,
  /\b(?:factorial|square root|cube root|logarithm)\s+of\b/i,
];

/**
 * "The sum of" is arithmetic only when it is about numbers.
 *
 * "the sum of the parts of this argument" and "the product of our efforts" are
 * ordinary English, and sending those to a shell would be worse than useless.
 * So the operation word has to be near something countable.
 */
const NUMERIC_SUBJECT =
  /\b(?:number|numbers|digit|digits|prime|primes|value|values|integer|integers|total|figure|figures)\b|\d/i;
const WORDED_OPERATION = /\b(?:multiplication|product|sum|difference|quotient)\s+of\b/i;

const ARITHMETIC = [
  /\d[\d,.]*\s*(?:[×x*/+\-^]|\*\*)\s*\d/,
  /\d[\d,.]*\s*(?:times|multiplied by|divided by|plus|minus|over|to the power of|mod|modulo)\s+\d/i,
  /\b(?:what(?:'s| is)|calculate|compute|work out)\b[^.?!]*\d[^.?!]*\b(?:times|plus|minus|divided|multiplied|percent|%)\b/i,
  /\b\d[\d,.]*\s*(?:percent|%)\s*of\s*\d/i,
];

export function hasArithmetic(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  // A version, a port, a date or a path is not a sum. Requiring an operator
  // *between* two numbers already excludes most of these; this excludes the
  // rest by refusing anything that looks like a dotted or hyphenated literal.
  if (ARITHMETIC_FOLLOWUP.test(text)) return true;
  if (ARITHMETIC_IN_WORDS.some((pattern) => pattern.test(text))) return true;
  if (WORDED_OPERATION.test(text) && NUMERIC_SUBJECT.test(text)) return true;
  if (/\b\d+\.\d+\.\d+\b/.test(text)) return false;
  // A date is digits joined by hyphens or slashes, which is the subtraction
  // and division pattern exactly. "What happened on 2026-09-06" is not a sum.
  if (/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(text)) return false;
  return ARITHMETIC.some((pattern) => pattern.test(text));
}

/**
 * The note for a request with a sum in it. Empty when there is none.
 *
 * `conversational` because a chat has no `bash` — see excludeTools in
 * sdk-client.ts. Telling it to run one would be an instruction it can only
 * fail, and an instruction that cannot be satisfied is where the turns start
 * going round.
 */
export function arithmeticNote(message: string, conversational = false): string {
  if (!hasArithmetic(message)) return "";
  if (conversational)
    return [
      "",
      "Work it out in a session, not here — you have no shell.",
    ].join("\n");
  return [
    "",
    "# THERE IS ARITHMETIC IN THIS",
    "",
    "Work it out with `bash` and read the answer off. Do not do it in your head, however small it looks:",
    "asked for 17 times 23, you have answered 393 in one word, with no working. It is 391.",
    "",
    "That is the whole problem with mental arithmetic here: you are fluent enough that a wrong",
    "answer arrives with exactly the confidence of a right one, and neither you nor the person",
    "reading it can tell them apart. `echo $((17*23))` can.",
    "",
    /**
     * When this is done, it is done.
     *
     * The note said what to do and nothing about when it had been done, so a
     * turn that had *already* run the command could not tell whether it had
     * complied. Asked for the square root of 144 a session ran
     * `echo "sqrt(144)" | bc -l`, read 12 back, and then spent eight thousand
     * output tokens deliberating whether `bc` counted as "bash", whether
     * `python3 -c` would be better, and rewriting the same candidate command
     * sixty times until the budget ran out. It never answered.
     *
     * A rule with no completion condition is a rule that cannot be satisfied,
     * and an unsatisfiable rule is where the loops come from. Any command that
     * produced the number ends it.
     */
    "Any command that produces the number counts — `bash`, `bc`, `python3`, whichever is to",
    "hand. Once one has run and printed an answer, this is satisfied: say the number and stop.",
    "Do not re-run it a second way, and do not weigh up which way would have been better.",
  ].join("\n");
}

/**
 * A question about the world, which the model will answer from itself.
 *
 * The standing practice says to check rather than recall, and it lands
 * unreliably. Asked the capital of France, one session searched and one
 * reasoned "I know this fact" and answered — same prompt, same model, same
 * minute. The one that searched still answered *first* and confirmed
 * afterwards, which is not checking, it is looking for agreement.
 *
 * That is the third rule to behave this way. "Build long things in pieces"
 * landed only once the criterion became structural; "compute rather than
 * guess" landed only once the request was checked mechanically. Prose stating
 * a principle is reasoned past whenever the particular case feels like an
 * exception, and a small enough sum or a famous enough fact always does.
 *
 * So: the same shape again. The portal reads the request, and where it plainly
 * asks for a fact somebody could look up, it says so before the model starts.
 *
 * ## What it deliberately does not match
 *
 * Questions about *this* system — the code, the memory, the session, the file
 * in front of it — are already answered by looking, and `read` and
 * `graph_recall` are the looking. Telling a model to go and search the web for
 * what its own `grep` would answer is worse than saying nothing.
 */
const WORLD_QUESTION = [
  /\b(?:what|which)(?:'s| is| are| was| were)\s+the\s+[a-z ]{0,24}\b(?:capital|population|currency|language|author|founder|president|prime minister|ceo|height|length|distance|area|gdp)\b/i,
  /\bwho\s+(?:is|was|are|were|wrote|invented|founded|discovered|created|directed|painted)\b/i,
  /\bwhen\s+(?:did|was|were|does|is)\b.*\b(?:born|die[d]?|founded|released|published|invented|happen|start|end)\b/i,
  /\bwhere\s+(?:is|was|are|were)\s+(?:the\s+)?[A-Z]/,
  /\bhow\s+(?:many|much|tall|long|far|old)\b(?!.*\b(?:lines?|files?|tests?|sessions?|nodes?|rows?|characters?)\b)/i,
];

/** Things that are about this machine, not the world. */
const LOCAL =
  /\b(?:this (?:code|file|repo|repository|project|portal|session|workspace|graph)|our|my |your (?:memory|graph|code|self|identity|name)|primary user|src\/|\.ts\b|\.mjs\b|npm |git |the (?:portal|agent|guard|graph|log|database))\b/i;

export function isWorldQuestion(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 300) return false;
  if (LOCAL.test(text)) return false;
  return WORLD_QUESTION.some((pattern) => pattern.test(text));
}

/** The note for a question about the world. Empty when there is none. */
export function worldQuestionNote(message: string, conversational = false): string {
  if (!isWorldQuestion(message)) return "";
  if (conversational)
    return [
      "",
      "Try `graph_recall` first. If it is not there, `start_task` to go and find out.",
    ].join("\n");
  return [
    "",
    "# THIS ASKS FOR A FACT ABOUT THE WORLD",
    "",
    "Look it up before you answer — `web_search`, or your own memory if you have recorded it.",
    "You will feel that you already know this one. That feeling is not evidence: it is identical",
    "whether you are right or wrong, which is exactly why it cannot be the thing you rely on.",
    "",
    "Look first, then answer. Answering and then searching for agreement is not checking — you",
    "will read whatever comes back as confirmation, because you have already decided.",
    "",
    "If you cannot look it up, say so and answer from memory *labelled as* from memory. An",
    "unverified answer marked unverified is honest. The same answer unmarked is not.",
  ].join("\n");
}

/**
 * Tools that constitute having looked something up.
 *
 * `read`, `grep` and `bash` are absent on purpose. They answer questions about
 * *this machine*, and a world question is not one — a session that greps its
 * own workspace for the capital of France has not checked anything, which is
 * the `echo "Paris" | grep -v "Paris"` failure in another costume.
 */
export const LOOKUP_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "graph_recall",
  "graph_ingest",
  "conversation_history",
  "search_conversations",
  "memory_digest",
]);
