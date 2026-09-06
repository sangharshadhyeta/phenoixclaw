import type { TaskRow } from "../db.js";
import { boundaryTail } from "./writing-tools.js";
import type { Supervision } from "./supervisor.js";

/**
 * One step, one context.
 *
 * Sisyphean ran each task in its plan in a context of its own, holding only
 * what that task needed to be done well. That was read here, in the first
 * feature audit, as scaffolding for a 0.6B model that could not keep a plan in
 * its head — and thrown away with the rest of the staging.
 *
 * It is not scaffolding. The three things it fixes are not small-model
 * problems:
 *
 *   - **Attention thins.** Step seven of a single accumulating conversation is
 *     written with six steps of tool output ahead of it and the least budget
 *     left. Step seven of its own conversation gets what step one got.
 *   - **Debris accumulates.** The grep that found nothing, the file read to
 *     check a name, the plan revised twice — all of it stays in the window,
 *     all of it competes for attention with the material that matters, and
 *     none of it is needed by the step in hand.
 *   - **Compaction summarises by recency, not relevance.** A long enough run
 *     hits it, and then the model is working from a summary nobody chose. This
 *     codebase has watched that happen: 1504 compactions in one run, a session
 *     re-reading the same README fifteen times because the tool result had
 *     been thrown away to make room.
 *
 * A large model in this shape does better than the same model in one long
 * conversation, for the same reason a large model with a plan does better than
 * one without: the constraint was never about capacity, it was about what is
 * in front of the model at the moment it writes.
 *
 * ## What "sufficient knowledge" means here
 *
 * Deciding what a step needs is the whole design. Too little and it invents
 * what it cannot see; too much and this is just the accumulating conversation
 * with extra steps. What goes in:
 *
 *   - the goal, so the step serves the request rather than itself;
 *   - the whole plan, so it knows what it is *not* doing — the single most
 *     effective line against a step that quietly does the next three;
 *   - what earlier steps *produced* (their recorded results), not how they
 *     produced it;
 *   - the end of the artefact, so what it writes follows on;
 *   - anything the supervisor said.
 *
 * What stays out: every tool call, every intermediate read, every revision of
 * the plan. If a step needs a file it can read it — that is a tool call, and a
 * cheap one, and it lands in a context with room for the answer.
 */

export interface StepBrief {
  /** The prompt for this step's own conversation. */
  message: string;
  /** The step it is for, so a caller can record what happened to it. */
  step: TaskRow;
}

export interface BriefContext {
  goal: string;
  tasks: TaskRow[];
  step: TaskRow;
  /** The document being written, when there is one. */
  file?: string | null;
  /** What is already in that file. */
  written?: string;
  supervision?: Supervision;
}

/**
 * The sections this step actually needs, pulled out by name.
 *
 * BirdClaw's progressive disclosure (`subtask_executor._read_for_context`)
 * looks for the *exact* section matching the item before falling back to the
 * tail of the file, and this had only the fallback. The gap shows on the step
 * that depends on the others: `describe`, which uses area, perimeter and
 * centroid, was given the last 1500 characters — so it saw `centroid` and had
 * to invent the signatures of the other two, in a file it had itself written.
 *
 * BirdClaw finds the section with a regex over headings and definitions. This
 * does not have to: `write_next` records where every section landed, so the
 * text can be sliced exactly. A step gets an earlier section when its own
 * description names it — which is what "uses all three" looks like once the
 * plan has been written down.
 *
 * Deliberately not "every earlier section": that is the accumulating context
 * this exists to avoid, arrived at by a different road.
 */
export function neededSections(
  step: TaskRow,
  tasks: TaskRow[],
  text: string,
): Array<{ description: string; body: string }> {
  const wanted = step.description.toLowerCase();
  const out: Array<{ description: string; body: string }> = [];
  for (const t of tasks) {
    if (t.seq >= step.seq || t.status !== "done") continue;
    const m = /@(\d+)-(\d+)$/.exec(String(t.result ?? ""));
    if (!m) continue;
    const name = t.description.trim().toLowerCase();
    // Word-ish match, so "area" does not hit "areas of concern" and, more to
    // the point, so a one-letter section name cannot match everything.
    if (name.length < 3 || !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(wanted)) continue;
    const [start, end] = [Number(m[1]), Number(m[2])];
    if (end > text.length) continue;
    out.push({ description: t.description, body: text.slice(start, end) });
  }
  return out;
}

/**
 * The signature lines of what is already written.
 *
 * `neededSections` only fires when a step's description names an earlier one,
 * and in a real plan the sections are bare nouns — "area", "perimeter",
 * "describe" — so the dependency the person stated ("a describe function that
 * uses all three") is nowhere in the step text. The step that needs the others
 * most is exactly the one whose name says least.
 *
 * Signatures rather than bodies, always. A function that calls three others
 * needs to know what they take and return; it does not need their
 * implementations, and including those is how a per-step context becomes the
 * accumulating one again. This is the middle rung of BirdClaw's progressive
 * disclosure: an index is too little, the whole file is too much.
 *
 * Prose gets its headings, for the same reason and at the same cost.
 */
export function signaturesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /^(export\s+)?(default\s+)?(async\s+)?(function|class)\s+\w/.test(trimmed) ||
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/.test(trimmed) ||
      /^def\s+\w/.test(trimmed) ||
      /^#{1,6}\s+\S/.test(trimmed)
    ) {
      // Up to the brace or arrow: the shape, not the body.
      out.push(trimmed.replace(/\s*\{\s*$/, "").replace(/\s*=>\s*$/, " =>").slice(0, 160));
    }
  }
  return out;
}

/** What has been written so far, by name — cheap, and it says what exists. */
function writtenIndex(tasks: TaskRow[], step: TaskRow): string {
  const done = tasks.filter((t) => t.seq < step.seq && t.status === "done");
  return done.length ? done.map((t) => t.description).join(", ") : "";
}

/** How a finished step is described to the ones after it. */
function producedBy(tasks: TaskRow[], upTo: number): string {
  const earlier = tasks.filter((t) => t.seq < upTo && (t.status === "done" || t.status === "failed"));
  if (!earlier.length) return "";
  return [
    "# WHAT THE EARLIER STEPS PRODUCED",
    "",
    ...earlier.map((t) =>
      t.status === "failed"
        ? `[${t.seq}] ${t.description} — did not work out: ${t.result || "no reason recorded"}`
        : `[${t.seq}] ${t.description} — ${t.result || "done, nothing recorded"}`,
    ),
  ].join("\n");
}

/**
 * The brief for one step.
 *
 * Pure, and tested as such: this is the whole of "sufficient knowledge", and
 * getting it wrong is not a crash, it is a step that quietly does the work of
 * three or invents what it could have read.
 */
export function briefFor(ctx: BriefContext): string {
  const { goal, tasks, step, file, written, supervision } = ctx;
  const remaining = tasks.filter((t) => t.status === "pending" && t.seq !== step.seq);

  return [
    "# THE GOAL",
    "",
    goal.trim() || "(not recorded)",
    "",
    "# THE PLAN",
    "",
    ...tasks.map((t) => {
      const marks: Record<string, string> = { done: "✓", failed: "✗", running: "▸" };
      const mark = t.seq === step.seq ? "→" : marks[t.status] ?? "·";
      return `${mark} [${t.seq}] ${t.description}${t.seq === step.seq ? "   ← this one" : ""}`;
    }),
    "",
    producedBy(tasks, step.seq) || undefined,
    producedBy(tasks, step.seq) ? "" : undefined,
    file && written?.trim()
      ? [
          `# WHAT IS ALREADY IN ${file}`,
          "",
          // A planned document lives in the shared artefact store, not in the
          // session's working directory, and a run given the absolute path
          // still reached for the short one first: `ls shapes.mjs`, an error,
          // then the full path. Wasteful, and the error alarms anyone watching.
          "That is the full path. The file is not in your working directory — use the path as given,",
          "and do not go looking for it with `ls`.",
          "",
          writtenIndex(tasks, step) ? `Written so far: ${writtenIndex(tasks, step)}.` : undefined,
          ...(() => {
            const signatures = signaturesOf(written);
            return signatures.length
              ? [
                  "",
                  "What it already defines, so this section matches it rather than guessing:",
                  "",
                  ...signatures.map((sig) => `  ${sig}`),
                ]
              : [];
          })(),
          ...neededSections(step, tasks, written).flatMap((sec) => [
            "",
            `This step names "${sec.description}", which you have already written. Here it is in full,`,
            "so you match it rather than guess at it:",
            "",
            sec.body,
          ]),
          "",
          "The file ends like this:",
          "",
          boundaryTail(written, 1500),
          "",
        ]
          // Only genuinely absent slots are dropped; the "" entries here are
          // the blank lines that keep the block readable.
          .filter((line) => line !== undefined)
          .join("\n")
      : file
        ? `# ${file} is empty so far.\n`
        : undefined,
    supervision?.note ? ["# STEPPING BACK", "", supervision.note, ""].join("\n") : undefined,
    "# THIS STEP",
    "",
    step.description,
    "",
    /**
     * The two sentences that make the isolation work rather than merely
     * happen.
     *
     * Saying what is *not* in front of it stops the model treating a missing
     * conversation as a memory failure and going looking for what it thinks it
     * has forgotten. Saying to do only this step is what stops it doing the
     * next three in one go and leaving the plan describing work that has
     * already happened.
     */
    "This step is already marked as in progress — `task_start` would do nothing, so do not call it.",
    "",
    "This is a fresh context, deliberately: you are not carrying the earlier steps' working, only",
    "what they produced, which is above. Nothing has been lost — if you need a file, read it.",
    "",
    remaining.length
      ? `Do this step and only this step. ${remaining.length} more will follow in their own turn; ` +
        `doing them now leaves the plan describing work that has already happened.`
      : "This is the last step.",
    file
      ? "Write it with `write_next`, which appends it to the file and marks the step done."
      : "Record how it turned out with `task_finish`, saying what actually came of it.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * The closing turn: what all of it came to.
 *
 * A plan worked step by step ends with the steps done and nobody having said
 * what happened — each step's own context knew only its own piece, and by
 * construction none of them saw the whole. Without this the person who asked
 * gets the last section of a document as the answer to their question.
 *
 * It gets its own context too, holding what every step produced and nothing of
 * how they produced it. And it is the turn where identity matters most: the
 * answer is the agent speaking, after a run in which it was working, and a long
 * accumulation is exactly what pushes self-concept out of the window. Here
 * there is no accumulation — the system prompt carrying SOUL.md and
 * SELF_CONCEPT.md is most of what is in front of it.
 */
export function synthesisBrief(ctx: {
  goal: string;
  tasks: TaskRow[];
  file?: string | null;
  supervision?: Supervision;
  problems?: string[];
  expectedOutcome?: string | null;
}): string {
  const { goal, tasks, file, supervision, problems, expectedOutcome } = ctx;
  const failed = tasks.filter((t) => t.status === "failed");

  return [
    "# WHAT WAS ASKED",
    "",
    goal.trim() || "(not recorded)",
    "",
    "# WHAT YOU DID",
    "",
    ...tasks.map((t) => {
      const marks: Record<string, string> = { done: "✓", failed: "✗", running: "▸" };
      const mark = marks[t.status] ?? "·";
      return `${mark} [${t.seq}] ${t.description}${t.result ? ` — ${t.result}` : ""}`;
    }),
    "",
    file ? `The result is in ${file}.` : undefined,
    file ? "" : undefined,
    supervision?.note ? `# STEPPING BACK\n\n${supervision.note}\n` : undefined,
    /**
     * The criterion, put back in front of the run that has to meet it.
     *
     * Recording it at the start is worth nothing on its own — BirdClaw's task
     * registry kept `expected_outcome` and the value was never in the storing.
     * It is in being asked, at the end, whether the thing you said you would
     * check is actually true, by something that cannot mark its own homework
     * against a standard it invents afterwards.
     */
    expectedOutcome
      ? [
          "# WHAT YOU SAID DONE WOULD LOOK LIKE",
          "",
          expectedOutcome,
          "",
          "You wrote that before starting. Say plainly whether it is true — and if you have not",
          "actually checked, check now or say that you have not. \"It should work\" is not an answer",
          "to a question you set yourself.",
          "",
        ].join("\n")
      : undefined,
    "# NOW ANSWER",
    "",
    "The work is done. Answer the person who asked — in your own voice, as yourself, not as a",
    "report on a process. They asked a question; give them what they wanted, not a list of steps",
    "you took to get it.",
    /**
     * Do not paste the artefact back.
     *
     * The first run to get this far reproduced the entire module in a code
     * block. It is a reasonable thing to do when the file is not in front of
     * you and you are being asked to present the work — but the file is on
     * disk, the person can open it, and a copy in the chat is a second version
     * that goes stale the moment either changes.
     */
    file
      ? `${file} is written and on disk. Do not paste it back — say what is in it and what is worth ` +
        `knowing about it. Anyone who wants the text can open the file.`
      : undefined,
    failed.length
      ? `Say plainly what did not work: ${failed.map((t) => `"${t.description}"`).join(", ")}. ` +
        `An answer that quietly omits the part that failed is worse than a shorter one that names it.`
      : undefined,
    problems?.length
      ? `The check still reports: ${problems.join(" ")} Say so — do not describe this as finished ` +
        `while that is true.`
      : undefined,
    "Each step ran in its own context, so this is the first time any of it has been in one place.",
    "That is the point — but it means you should look at what is above rather than at what you",
    "remember, because you were not there for most of it.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * A turn for fixing what the check found, and nothing else.
 *
 * Its own context, holding the defects and the file — not the run that
 * produced them. A model shown how a mistake was made argues about whether it
 * was one; a model shown the mistake fixes it.
 */
export function fixBrief(ctx: { goal: string; tasks: TaskRow[]; file?: string | null; problems: string[] }): string {
  const { goal, file, problems } = ctx;
  return [
    "# WHAT WAS ASKED",
    "",
    goal.trim() || "(not recorded)",
    "",
    "# WHAT IS WRONG WITH THE RESULT",
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    file ? `It is in ${file}. Read it.` : "",
    "",
    "Fix exactly these, and nothing else.",
    "",
    "Use `write_revise` to replace a section in place rather than rewriting the whole file — the",
    "file was built a section at a time and a whole-file write is how half of it goes missing,",
    "which may well be what you are here to fix. `read_section` reads one back by its number.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Why a plan run stopped, so the caller can say so rather than going quiet. */
export type StepOutcome = "finished" | "no-plan" | "stalled" | "off-track" | "interrupted";

export interface StepRunDeps {
  tasks: () => Promise<TaskRow[]>;
  document: () => Promise<{ file?: string | null; written?: string }>;
  /** Retire the conversation so the next step gets a fresh one. */
  recycle: () => Promise<void>;
  /** Prompt and wait — see SessionManager.ask. */
  ask: (message: string) => Promise<string>;
  supervise?: () => Promise<Supervision | undefined>;
  note?: (text: string) => Promise<void>;
  /** Add steps for what the supervisor says is still missing. True if any were added. */
  extend?: (missing: string) => Promise<boolean>;
  /** Mark the unstarted steps skipped, with a reason. */
  skipRemaining?: (why: string) => Promise<void>;
  /** Everything mechanically wrong with the artefact. Empty when it is sound. */
  verify?: () => Promise<string[]>;
  /**
   * Mark the step in progress before the turn that does it.
   *
   * The runner knows which step it is asking for, so leaving the model to say
   * so with `task_start` is a wasted call — and worse than wasted: it was
   * `task_start` marking a step running that made `write_next`, which looked
   * only at `pending`, skip it and file the text under the next one.
   */
  start?: (seq: number) => Promise<void>;
  /** Record what this run produced, so a later run can improve on it. */
  remember?: () => Promise<void>;
  /** What the run said "done" would look like, if it said. */
  expected?: () => Promise<string | null | undefined>;
}

/**
 * Work a plan, one isolated context per step.
 *
 * Stops when the plan is done, when a step does not advance it (rather than
 * looping on the same one), or when the supervisor says the work has left the
 * thing that was asked. Never runs a step twice: if a turn ends with the same
 * step still pending, that is a stall and is reported, because retrying it
 * with the same brief would produce the same turn.
 */
export async function runPlan(goal: string, deps: StepRunDeps, limit = 40): Promise<StepOutcome> {
  let supervision: Supervision | undefined;
  /**
   * How many times the supervisor may send the work back for more.
   *
   * Bounded, because "not deep enough yet" is a judgement that can always be
   * made again — there is no depth at which a sufficiently demanding reader
   * runs out of things to want. Two rounds is enough to catch an answer
   * assembled from nothing and few enough that a session cannot spend its
   * afternoon being told to try harder.
   */
  /** How many step briefs this run has issued — see the closing turn below. */
  let briefsIssued = 0;
  let deepenings = 0;
  const MAX_DEEPENINGS = 2;
  /** Attempts at the same list of defects. A third would be the second again. */
  const MAX_FIXES = 2;

  for (let i = 0; i < limit; i++) {
    const tasks = await deps.tasks();
    const step = tasks.find((t) => t.status === "pending" || t.status === "running");

    if (!step) {
      if (!tasks.length) return "no-plan";
      /**
       * A plan that was already finished before this call is not answered
       * again. The closing turn belongs to work that just happened; firing it
       * on arrival would have the portal re-answer a question the person has
       * already had an answer to, in a fresh context, out of nowhere.
       */
      if (i === 0) return "finished";

      // Every step is closed. Before answering, ask whether it actually
      // amounts to what was wanted — this is the judgement the worker cannot
      // make from inside, and the last honest place to make it.
      const done = supervision ?? (await deps.supervise?.());
      if (done?.verdict === "deepen" && deepenings < MAX_DEEPENINGS && deps.extend) {
        deepenings++;
        await deps.note?.(`Not finished yet: ${done.note}`);
        // The supervisor names what is missing; the worker turns that into
        // steps. Asking it to extend its own plan rather than inventing steps
        // here keeps planning in one place.
        const added = await deps.extend(done.note);
        if (added) {
          supervision = done;
          continue;
        }
      }

      /**
       * Verify before answering.
       *
       * BirdClaw's write guard and subtask verifier, which existed because a
       * model finishes a file, believes it is done, and is wrong in ways a
       * string comparison can see: a section that shrank because the file was
       * rewritten rather than appended to, a stub left behind, code that does
       * not parse. Per-step isolation makes this *more* necessary, not less —
       * no single context ever saw the whole artefact, so nothing in the run
       * so far has looked at it end to end.
       *
       * A fix gets its own context too, holding the problems and the file and
       * nothing else. Bounded, and the problems that survive go into the
       * closing turn rather than being swallowed: an answer that says "done"
       * over a file that does not parse is the failure this whole loop is for.
       */
      /**
       * The closing turn earns its place, or is skipped.
       *
       * It exists because each isolated step saw only its own piece, so
       * something has to put the whole in one place. When the run only ever
       * issued one brief that is not true — that turn saw everything and has
       * already answered — and synthesising again is a wasted call that
       * produces a worse answer: the first run to do it re-read the file and
       * pasted the whole module back.
       */
      const isolated = briefsIssued > 1;

      let problems = (await deps.verify?.()) ?? [];
      for (let fix = 0; fix < MAX_FIXES && problems.length; fix++) {
        await deps.note?.(`Checking the result: ${problems.length} problem(s) to fix.`);
        await deps.recycle();
        await deps.ask(fixBrief({ goal, tasks, file: (await deps.document()).file, problems }));
        problems = (await deps.verify?.()) ?? [];
      }

      const { file } = await deps.document();
      // Recorded before the answer rather than after: the artefact is finished
      // at this point, and the closing turn is where a run has most often gone
      // quiet on us. Prior work nobody can find is prior work that does not
      // exist.
      await deps.remember?.();
      if (!isolated && !problems.length) return "finished";
      await deps.recycle();
      await deps.ask(
        synthesisBrief({ goal, tasks, file, supervision: done, problems, expectedOutcome: await deps.expected?.() }),
      );
      return "finished";
    }

    const { file, written } = await deps.document();
    await deps.start?.(step.seq);
    await deps.recycle();
    briefsIssued++;
    await deps.ask(briefFor({ goal, tasks, step, file, written, supervision }));

    const after = await deps.tasks();
    const still = after.find((t) => t.seq === step.seq);
    if (still && (still.status === "pending" || still.status === "running")) {
      // The step ran and did not close. Running it again would hand the same
      // brief to the same model and get the same turn; say so instead.
      await deps.note?.(
        `Step [${step.seq}] "${step.description}" did not complete. Stopping here rather than ` +
          `repeating it — the plan and everything written so far are intact.`,
      );
      return "stalled";
    }

    supervision = await deps.supervise?.();
    if (supervision?.verdict === "off-track") {
      await deps.note?.(`Stopping: ${supervision.note}`);
      return "off-track";
    }
    /**
     * "You have enough — write it" ends the gathering, never the deliverable.
     *
     * The verdict is about research: more searching will not improve an answer
     * the material already supports. Applied to a plan whose steps *are* the
     * output it does the opposite of its intent — a live run wrote area,
     * perimeter and centroid, and the supervisor skipped "describe", which the
     * person had asked for by name. The plan then recorded it as "not needed",
     * which was not true and not the supervisor's call to make: it judges
     * whether there is enough to work from, not whether the thing asked for is
     * worth delivering.
     *
     * So it only ends gathering when the remaining steps are gathering. With a
     * document in progress every step is a section somebody is waiting for.
     */
    if (supervision?.verdict === "synthesize" && deps.skipRemaining && !file) {
      await deps.note?.(`Enough gathered: ${supervision.note}`);
      await deps.skipRemaining(supervision.note);
    }
  }
  return "stalled";
}
