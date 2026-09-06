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
  if (/\b\d+\.\d+\.\d+\b/.test(text)) return false;
  // A date is digits joined by hyphens or slashes, which is the subtraction
  // and division pattern exactly. "What happened on 2026-09-06" is not a sum.
  if (/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(text)) return false;
  return ARITHMETIC.some((pattern) => pattern.test(text));
}

/** The note for a request with a sum in it. Empty when there is none. */
export function arithmeticNote(message: string): string {
  if (!hasArithmetic(message)) return "";
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
  ].join("\n");
}
