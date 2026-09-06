import { hasArithmetic, isWorldQuestion, LOOKUP_TOOLS } from "./preflight.js";

/**
 * Checking, afterwards, that the turn did what it was told.
 *
 * Every standing practice in this portal was first written as prose in the
 * system prompt, and every one of them was reasoned past:
 *
 *   - "build long things in pieces" — a module of four functions is not a
 *     book, so one `write` call;
 *   - "compute rather than guess" — seventeen times twenty-three is small, so
 *     393 in one word, with no working;
 *   - "check rather than recall" — the capital of France is a thing I know, so
 *     no lookup at all;
 *   - and once the model *did* check: `echo "Paris" | grep -v "Paris"`.
 *
 * None of those are disobedience. Each is a particular case that genuinely
 * feels like an exception, and the model is deciding mid-generation with the
 * whole rest of the task competing for attention. A rule that has to be
 * remembered at exactly the wrong moment is not a rule, it is a hope.
 *
 * The two that stuck became mechanical: `write_plan` ends the turn, and the
 * request is read for arithmetic before the model sees it. This is that same
 * move made general — the portal looks at what the turn *did*, compares it
 * against what the request *asked for*, and where those disagree it gives the
 * turn back rather than letting the answer stand.
 *
 * ## Why afterwards rather than before
 *
 * Before is a prompt, and prompts are what failed. Afterwards there is
 * evidence: the tool calls are in the event log, and "was `web_search` called"
 * is a fact rather than an intention.
 *
 * ## Why it hands back rather than blocks
 *
 * The turn already happened; refusing it would throw away work and leave
 * nothing in its place. Handing it back costs one more turn and the model
 * arrives at it knowing what it missed — which is the only correction that
 * ever lands, since it now has the evidence rather than the principle.
 *
 * Once per turn, never twice. A second pass is arguing, and these are not
 * matters of opinion: either the tool was called or it was not.
 */

export interface TurnCall {
  toolName: string;
  args: string;
}

export interface TurnContext {
  /** True for the main chat or a channel conversation — not a task or routine. */
  conversational: boolean;
}

export interface AfterTurnCheck {
  /** Short name, for the audit line. */
  name: string;
  /** Does this request call for the check at all? */
  applies: (request: string, context: TurnContext) => boolean;
  /** Did the turn satisfy it? */
  satisfied: (calls: TurnCall[]) => boolean;
  /** What to hand back. */
  message: string;
}

/**
 * A bash command whose output is decided by its own input.
 *
 * `echo "Paris" | grep -v "Paris"` satisfies "run a command" exactly and can
 * only ever agree with what went in. So can `echo $((2+2))` — which is why
 * this looks for an echoed *string literal* rather than an expression: an
 * arithmetic expansion computes something the model did not know, and a quoted
 * word does not.
 */
export function selfConfirming(command: string): boolean {
  const text = command.trim();
  // An echo of a literal, with nothing that consults anything.
  if (!/^echo\s+["'][^"']+["']/.test(text)) return false;
  if (/\$\(|\$\{|\$\(\(|`/.test(text)) return false;
  return !/\b(curl|wget|cat|ls|find|grep\s+-r|python|node|date|uname)\b/.test(text.replace(/^echo\s+["'][^"']*["']/, ""));
}

/**
 * A request to build something, as opposed to a question about something.
 *
 * Deliberately about the *verb*. "Write a module", "build me a script", "create
 * a report" is work; "what does this do", "how would I", "explain" is a
 * question, and a conversation answers questions itself.
 */
const ASKS_FOR_WORK =
  /\b(?:write|build|create|make|implement|generate|refactor|add|fix|port|set up|scaffold)\b[^.?!]{0,80}\b(?:module|script|file|program|class|function|report|guide|document|test|suite|page|component|endpoint|\w+\.(?:py|mjs|js|ts|tsx|md|json|sh|go|rs))\b/i;

export function asksForWork(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 600) return false;
  // A question about work is still a question.
  if (/^\s*(?:what|why|how|when|where|which|who|is|are|does|do|can|should|would)\b/i.test(text)) return false;
  return ASKS_FOR_WORK.test(text);
}

export const AFTER_TURN_CHECKS: AfterTurnCheck[] = [
  {
    /**
     * A conversation asked to build something must hand it out.
     *
     * BirdClaw's soul layer force-created the task in Python when routing
     * failed (`soul_loop._force_create_task`) — not a prompt, a decision the
     * code made. Here the tool exists, is described, and was reasoned past
     * three times in a row: first the model wrote the file into the agent's
     * home, then into a workspace it did not own, and when both were refused it
     * pasted the module into the reply and called nothing at all.
     *
     * That last one is why this is an after-turn check rather than a guard: a
     * guard needs a tool call to intercept, and the failure mode is calling no
     * tool. What the turn *did not do* is only visible once it is done.
     */
    name: "work-not-handed-out",
    applies: (request, context) => context.conversational && asksForWork(request),
    satisfied: (calls) => calls.some((c) => c.toolName === "start_task"),
    message: [
      "That was a request to build something, and you answered it here.",
      "",
      "This is a conversation. Work gets a session of its own: `start_task` gives it an id, a",
      "workspace and a plan, it runs while you carry on talking, and its answer comes back here",
      "when it has one. Pasting a module into a reply produces no file, leaves nothing anyone can",
      "run, and is lost when this conversation is trimmed.",
      "",
      "Hand it out now. Write the brief for someone who cannot see what we have said — what to",
      "build, and what counts as done.",
    ].join("\n"),
  },
  {
    name: "world-question-unchecked",
    applies: isWorldQuestion,
    satisfied: (calls) => calls.some((c) => LOOKUP_TOOLS.has(c.toolName)),
    message: [
      "You answered that without consulting anything.",
      "",
      "It is a question about the world, so the answer is not yours to know — it is something with",
      "a source, and you have not been to it. Look it up now: `web_search`, or `graph_recall` if",
      "you have recorded it before.",
      "",
      "Then say what you found. If it agrees with what you said, say so and that it is now checked.",
      "If it disagrees, correct yourself plainly. If you genuinely cannot look it up, say that and",
      "label the answer unverified.",
    ].join("\n"),
  },
  {
    name: "arithmetic-in-head",
    applies: hasArithmetic,
    satisfied: (calls) =>
      calls.some((c) => c.toolName === "bash" && !selfConfirming(argOf(c, "command"))),
    message: [
      "There was arithmetic in that and you did it in your head.",
      "",
      "Put it through `bash` and read the answer off — `echo $((17*23))`. Then say whether it",
      "matches what you said, and correct it if not.",
      "",
      "You are fluent enough that a wrong answer arrives with exactly the confidence of a right",
      "one. Neither you nor the person reading it can tell them apart; the shell can.",
    ].join("\n"),
  },
  {
    name: "self-confirming-check",
    // Applies to any turn — this is about what the turn did, not what was asked.
    applies: () => true,
    satisfied: (calls) =>
      !calls.some((c) => c.toolName === "bash" && selfConfirming(argOf(c, "command"))),
    message: [
      "One of those commands only told you what you already told it.",
      "",
      'Echoing your own answer and reading it back — `echo "Paris" | grep -v "Paris"` — satisfies',
      '"run a command" and can only ever agree with what went in. It will confirm you every time,',
      "including the times you are wrong.",
      "",
      "If you meant to check something, ask something with its own source: the file, the real",
      "output of a real command, the page, a search. If you did not need to check, do not perform",
      "checking — say plainly what you know and how you know it.",
    ].join("\n"),
  },
];

function argOf(call: TurnCall, key: string): string {
  try {
    const parsed = JSON.parse(call.args) as Record<string, unknown>;
    const value = parsed?.[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** The first check this turn failed, or undefined when it is sound. */
export function failedCheck(
  request: string,
  calls: TurnCall[],
  context: TurnContext = { conversational: false },
): AfterTurnCheck | undefined {
  for (const check of AFTER_TURN_CHECKS) {
    if (!check.applies(request, context)) continue;
    if (check.satisfied(calls)) continue;
    return check;
  }
  return undefined;
}
