import { complete, localModelConfigured } from "../llm.js";
import { readIdentity } from "../identity.js";
import { listTasks, recentToolCalls, recentToolFailures, type TaskRow } from "../db.js";

/**
 * The outer loop: something that watches the work and is not doing it.
 *
 * The worker — pi's agent loop — is a good planner and a poor judge of its own
 * progress, for a structural reason rather than a failure of capability: every
 * observation it has made is in its own context, so the fourth identical `read`
 * looks reasonable from inside, and "I have enough to answer" is a judgement
 * made by the same attention that just spent itself gathering. Asking it to
 * step back is asking the thing that is deep in the work to notice that it is.
 *
 * So this is a *separate call*. Not a paragraph appended to the worker's
 * prompt — a second model call with a different job, a different prompt, and a
 * view assembled from the outside: the original request, the plan and how far
 * it has moved, what has actually been looked at, and who the agent is. It
 * reaches one verdict and, when it has something to say, says it to the worker.
 *
 * ## Why identity is in it
 *
 * This is the loop that decides whether an answer is finished, and "finished"
 * is not a property of the material — it is a standard, and the standard is
 * part of who the agent is. A supervisor without SELF_CONCEPT.md is a generic
 * progress checker; with it, the judgement is the agent's own. It is also the
 * loop whose verdict shapes the final answer, which is the moment identity
 * matters most and the moment a long context has usually pushed it out.
 *
 * ## What it may do
 *
 * Nudge, and only nudge. Its verdict becomes a note in the worker's next
 * request; it cannot call a tool, cancel a run, or edit the plan. That is the
 * deliberate limit: a supervisor that could act would be a second agent with
 * no supervisor of its own, and the failure mode of a wrong nudge is a
 * sentence the worker can disagree with, which is recoverable.
 *
 * ## When it runs
 *
 * Not every request — it is a whole model call, and one per turn of a
 * twenty-turn run would double the cost of everything for a judgement that
 * changes slowly. It runs when there is something new to judge: every few tool
 * calls, and whenever the plan moves. Between those, the previous verdict
 * stands and is re-shown, because a judgement the worker has already been
 * given is not less true for being a minute old.
 */

export type Verdict = "continue" | "deepen" | "synthesize" | "off-track" | "stuck";

export interface Supervision {
  verdict: Verdict;
  note: string;
}

/** How many tool calls may pass before the supervisor looks again. */
const REVIEW_EVERY = Number(process.env.SUPERVISOR_EVERY || 4);

/** How many recent calls it is shown. Enough to see a repetition, not a transcript. */
const WINDOW = 14;

/**
 * Repetition, found without a model.
 *
 * The one form of stuck that needs no judgement: the same tool with the same
 * arguments, returning the same thing, three times. No amount of context makes
 * that productive, and spending a model call to discover it would be spending
 * one to learn what a string comparison already knows. It is also the case a
 * cap used to "solve" by killing the run — which cured the symptom by ending
 * the patient.
 */
/**
 * A tool that is not working, called until the run gives up.
 *
 * The repetition check below catches the same call made over and over. This
 * catches the harder case: a tool that is broken, called with *different*
 * arguments each time and failing identically every time.
 *
 * Watched live, on a session whose working directory had gone: `ls -a`, `echo
 * "hello"`, `ls /` — three commands, one error. Then the model stopped calling
 * tools altogether and span in its own thinking, writing "I'll try to use
 * `bash` with `ls /`" forty times until a person killed it. It had nowhere to
 * go and nothing had told it so; from inside, trying once more is always the
 * most reasonable next move.
 *
 * Two identical failures is enough. A third adds no information, and the loop
 * that follows costs the whole run.
 */
export function brokenTool(failures: Array<{ toolName: string; error: string }>): string | undefined {
  const counts = new Map<string, { n: number; error: string }>();
  for (const failure of failures.slice(-6)) {
    // The first line only: a stack trace or a path that varies per call would
    // otherwise make two of the same failure look like two different ones.
    const signature = `${failure.toolName}:${failure.error.split("\n")[0].slice(0, 200)}`;
    const seen = counts.get(signature);
    counts.set(signature, { n: (seen?.n ?? 0) + 1, error: failure.error.split("\n")[0] });
  }
  for (const [signature, { n, error }] of counts) {
    if (n < 2) continue;
    const tool = signature.slice(0, signature.indexOf(":"));
    return (
      `\`${tool}\` has failed ${n} times in a row with the same error, whatever you pass it:\n\n` +
      `  ${error}\n\n` +
      `It is not going to start working. Stop calling it. Say plainly that it is unavailable and ` +
      `what that prevents, then do what you can with the tools that do work — and if the answer ` +
      `genuinely needs it, say so instead of guessing at what it would have told you.`
    );
  }
  return undefined;
}

export function repetition(calls: Array<{ toolName: string; args: string }>): string | undefined {
  if (calls.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const call of calls.slice(-8)) {
    const key = `${call.toolName}:${call.args}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counts) {
    if (n >= 3) {
      const tool = key.slice(0, key.indexOf(":"));
      return (
        `You have called \`${tool}\` with the same arguments ${n} times and had the same result each ` +
        `time. It will not change. Use what you already have, try something different, or say plainly ` +
        `what is blocking you — but do not call it again.`
      );
    }
  }
  return undefined;
}

/** A short, honest picture of where the work has got to. */
function progressOf(tasks: TaskRow[]): string {
  if (!tasks.length) return "No plan has been written.";
  const done = tasks.filter((t) => t.status === "done");
  const running = tasks.find((t) => t.status === "running");
  return [
    `${done.length} of ${tasks.length} steps done.`,
    running ? `Currently on: "${running.description}".` : "",
    ...tasks.map((t) => `  [${t.seq}] ${t.description} — ${t.status}${t.result ? `: ${t.result}` : ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM = [
  "You are the part of this agent that watches its own work.",
  "",
  "Another part of you is doing the work: reading, searching, planning, writing. You are not.",
  "You see the request it was given, the plan it wrote, how far that plan has moved, and what it",
  "has actually looked at. Your job is to judge whether it is getting there — and to say something",
  "only when saying something would change what happens next.",
  "",
  "Reach exactly one verdict:",
  "",
  "  continue    — it is making progress on the right thing. Say nothing.",
  "  deepen      — it is about to answer, or has answered, from less than it needs. Name what is",
  "                missing, specifically: which fact, which file, which source.",
  "  synthesize  — it has what it needs and is still gathering. Tell it to stop and write.",
  "  off-track   — what it is doing no longer serves what was asked. Say what was asked, and what",
  "                it is doing instead.",
  "  stuck       — it is repeating itself or has stopped advancing. Say what to try instead.",
  "",
  "Judge against the request, not against how much work has been done. A short question answered",
  "in one step is finished, not lazy. A factual claim assembled from memory with nothing checked is",
  "not finished, however many steps it took.",
  "",
  "Answer as exactly two lines:",
  "VERDICT: <one of the five words>",
  "NOTE: <one or two sentences addressed to the worker, or the single word none>",
].join("\n");

const VERDICTS: Verdict[] = ["continue", "deepen", "synthesize", "off-track", "stuck"];

/** Pull the verdict and note out of a completion that may be fenced or prefaced. */
export function parseSupervision(text: string | undefined): Supervision | undefined {
  if (!text) return undefined;
  const verdictLine = /VERDICT:\s*([a-z-]+)/i.exec(text);
  const verdict = VERDICTS.find((v) => v === verdictLine?.[1]?.toLowerCase());
  if (!verdict) return undefined;
  const noteLine = /NOTE:\s*([\s\S]+)/i.exec(text);
  const note = (noteLine?.[1] ?? "").trim().split("\n")[0].trim();
  if (!note || /^none\.?$/i.test(note)) return { verdict, note: "" };
  return { verdict, note };
}

/**
 * Look at the work and reach a verdict.
 *
 * Returns undefined when there is nothing to say — no local model configured,
 * or the call failed. A supervisor that cannot reach its model must not stop
 * the work it was supervising, so every failure here is silence.
 */
export async function supervise(
  sessionId: string,
  request: string,
  deps: {
    tasks?: () => Promise<TaskRow[]>;
    calls?: () => Promise<Array<{ toolName: string; args: string }>>;
    failures?: () => Promise<Array<{ toolName: string; error: string }>>;
    self?: () => Promise<string>;
    ask?: (system: string, user: string) => Promise<string | undefined>;
  } = {},
): Promise<Supervision | undefined> {
  const askModel = deps.ask ?? ((s: string, u: string) => complete(s, u, { maxTokens: 400, temperature: 0.2 }));
  const calls = await (deps.calls ?? (() => recentToolCalls(sessionId, WINDOW)))();

  // The cheap checks first, and neither needs the model at all. Broken before
  // repeated: "this tool does not work" explains the repetition, and saying
  // "you are going in circles" to a session whose bash has vanished is true
  // and useless.
  const broken = brokenTool(await (deps.failures ?? (() => recentToolFailures(sessionId, 10)))());
  if (broken) return { verdict: "stuck", note: broken };

  const repeated = repetition(calls);
  if (repeated) return { verdict: "stuck", note: repeated };

  if (!deps.ask && !localModelConfigured()) return undefined;

  const tasks = await (deps.tasks ?? (() => listTasks(sessionId)))();
  const self = await (deps.self ?? (async () => {
    try {
      return await readIdentity("SELF_CONCEPT.md");
    } catch {
      return "";
    }
  }))();

  const user = [
    "# WHAT WAS ASKED",
    request.slice(0, 2000) || "(not recorded)",
    "",
    "# THE PLAN, AND HOW FAR IT HAS MOVED",
    progressOf(tasks),
    "",
    "# WHAT IT HAS ACTUALLY DONE",
    calls.length ? calls.map((c) => `  ${c.toolName} ${c.args.slice(0, 160)}`).join("\n") : "  Nothing yet.",
    self ? `\n# WHO YOU ARE\n${self.slice(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return parseSupervision(await askModel(SYSTEM, user));
}

/** Whether enough has happened since the last review to be worth another. */
export function dueForReview(callsSeen: number, lastReviewedAt: number): boolean {
  return callsSeen - lastReviewedAt >= REVIEW_EVERY;
}

/** How the verdict is put to the worker. Empty when there is nothing to say. */
export function superviseBlock(s: Supervision | undefined): string {
  if (!s || s.verdict === "continue" || !s.note) return "";
  const heading: Record<Verdict, string> = {
    continue: "",
    deepen: "You do not have enough yet",
    synthesize: "You have enough — write it",
    "off-track": "This is not what was asked",
    stuck: "You are going in circles",
  };
  return [
    "",
    "# STEPPING BACK",
    "",
    `${heading[s.verdict]}. ${s.note}`,
    "",
    "This is you, looking at your own work from outside it. Act on it or say why it is wrong —",
    "do not simply carry on as though it were not there.",
  ].join("\n");
}
