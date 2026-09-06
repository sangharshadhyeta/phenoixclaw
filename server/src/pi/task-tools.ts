import { Type } from "typebox";
import { selfContainmentNote } from "./step-text.js";
import { getSession, listTasks, nextTask, setTaskStatus, setTasks, updateSession, type TaskRow } from "../db.js";

/**
 * The agent's own checklist for the work in front of it. Ports BirdClaw's
 * `agent/task_list.py`.
 *
 * Not BirdClaw's task *registry* (`memory/tasks.py`), which is a different
 * thing wearing a similar name: that exists because BirdClaw has no sessions,
 * so a task is its unit of work with an owner and a lifecycle. This portal's
 * `sessions` table already is that, and porting the registry would be building
 * a second one with the same columns.
 *
 * It is also not a routine. A routine is something you asked for, on a
 * schedule, and you write it. These are written by the agent, about the work
 * it is doing right now, and the UI shows them rather than editing them —
 * watching it think, not another queue to keep filled.
 *
 * It replaces what the learning loop was doing with a free-text "current plan"
 * node in the graph: the same idea, but a plan you can see, and one whose
 * steps have a state the next iteration can read without parsing prose.
 */

const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const MARK: Record<string, string> = { pending: "·", running: "▸", done: "✓", failed: "✗" };
const render = (tasks: TaskRow[]): string =>
  tasks.length
    ? tasks.map((t) => `${MARK[t.status] ?? "·"} [${t.seq}] ${t.description}${t.result ? ` — ${t.result}` : ""}`).join("\n")
    : "No plan yet.";

/**
 * Pull the step text out of whatever shape arrived.
 *
 * Three live runs sent three different wrong shapes, each a reasonable reading
 * of "one short line per step": an array of `{step, description}` objects, the
 * same with every key double-quoted (JSON written inside JSON), and — seven
 * times in a row, unchanged by an error message showing the correct call —
 * the whole argument object nested inside itself, `{"steps": [{"steps":
 * [...]}]}`.
 *
 * Being strict here has now cost more turns than any other single thing in the
 * portal. A tool that knows what was meant should take it: the shape is not
 * the point, the plan is. So this walks whatever it is given and collects the
 * strings, in order.
 *
 * The floor is that a step must be text. Numbers are indices, not
 * descriptions — `{"step": 1, "description": 1}` has no step in it at all, and
 * inventing one called "1" would put a garbage line in the plan rather than
 * admit the call could not be read.
 */
/**
 * Chat-template markers and JSON punctuation that leaked into a string.
 *
 * Being liberal about *shape* is right; being liberal about *content* is not,
 * and the difference cost a run. When this only accepted a flat list of
 * strings, a model whose tool-call generation broke down was refused and
 * retried until it got it right. Once it accepted any shape, the same
 * breakdown produced a plan whose first step read
 *
 *     Plan the creation of stats.mjs with sections: mean, median…"}\n]}\n]}
 *     <tool_call|><|channel>thought<channel|><|tool_call>call:expected_outcome{
 *
 * — the model's own template tokens, stored as the work to be done and handed
 * back to it as a brief. Silently accepting corrupted text is worse than
 * refusing it: a refusal is retried, and a bad plan is carried out.
 *
 * So the text is cut at the first marker and kept only if what remains still
 * reads as a step.
 */
const LEAKED = /<\|?(?:tool_call|channel|im_start|im_end|endoftext|assistant|user)\b|<\/?channel\|?>|\bcall:[a-z_]+\{/i;
/** A run of quotes, braces, brackets, commas and whitespace at the end. */
const JSON_TAIL = /[\s"'`}\],]+$/;

function cleanStep(raw: string): string {
  let text = raw.trim();
  const leak = LEAKED.exec(text);
  if (leak) text = text.slice(0, leak.index).trim();
  // Trailing JSON punctuation, from a string that ran past its own closing
  // quote and swallowed the structure around it. One pass: the character class
  // covers the whole run rather than one bracket at a time.
  text = text.replace(JSON_TAIL, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  // What is left has to look like something a person could carry out. Two
  // characters of debris is not a step.
  if (text.length < 3) return "";
  // Unbalanced quotes or braces mean this was a fragment of a larger
  // structure, not a sentence.
  if ((text.match(/[{}]/g) ?? []).length > 2) return "";
  return text;
}

export function collectSteps(input: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof input === "string") {
    const text = cleanStep(input);
    return text ? [text] : [];
  }
  if (Array.isArray(input)) return input.flatMap((item) => collectSteps(item, depth + 1));
  if (input && typeof input === "object") {
    const out: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const name = key.replace(/^"+|"+$/g, "").toLowerCase();
      // A field that is plainly not step text: an index, a kind, a flag.
      if (["type", "kind", "status", "done", "index", "id", "seq", "n"].includes(name)) continue;
      out.push(...collectSteps(value, depth + 1));
    }
    return out;
  }
  return [];
}

/** An ExtensionFactory — see pi's InlineExtension. One per session, bound to it. */
export function taskTools(sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "task_plan",
      label: "Plan",
      description:
        "Write down the steps for the work in front of you, in the order you mean to do them. Call it " +
        "again to revise the plan when what you have found changes what should happen next — that is " +
        "expected, not a failure. Steps you have already finished keep their result across a rewrite, " +
        "so repeat them unchanged if they still belong in the plan.\n\n" +
        "`steps` is a flat list of plain strings — one sentence each, no numbering, no objects:\n\n" +
        '  {"steps": ["Read src/parser.ts and note how tokens are produced", ' +
        '"Add the missing case for block comments", "Run npm test and fix what breaks"]}\n\n' +
        "Each step is carried out in a context of its own — it is given this plan and what the " +
        "earlier steps produced, not the conversation you are having now. So write each one to be " +
        "followed by someone who was not here: \"Run `npm test -w server` and fix any failure\", " +
        "never \"continue the work\", \"finish it off\", or \"same as above\". Do not add a step " +
        "for planning; this is it.",
      promptSnippet: "task_plan — write or revise the steps for this work",
      /**
       * Liberal in what it accepts, because strict cost a live run six turns.
       *
       * Asked to plan, the model sent `steps` as an array of *objects* —
       * `{"step": 1, "description": "..."}` — which is a perfectly reasonable
       * reading of "one short line per step, in order", and which the schema
       * rejected with `steps.0: must be string`. Worse, its keys arrived
       * double-quoted (`"\"step\""`: JSON written inside JSON), so the error
       * echoed back something that looked nothing like a fix. It retried six
       * times, got the same message each time, and recovered by accident.
       *
       * BirdClaw had a response adapter for exactly this and the feature audit
       * filed it under things only a small model needs. It is not: this was a
       * 26B model, and the shape it chose was the sensible one. A tool that
       * knows what was meant should accept it — the cost of being permissive
       * here is a `String()` call, and the cost of being strict was measured.
       */
      parameters: Type.Object({
        steps: Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({}, { additionalProperties: true }),
          ]),
          { description: "One short line per step, in order. Plain strings." },
        ),
      }),
      async execute(_id: string, p: any) {
        const steps = collectSteps(p.steps);
        if (!steps.length) {
          /**
           * Show the call, do not describe it.
           *
           * The message this replaced said "give `steps` as a list of plain
           * strings", which is exactly what the schema already said, and a
           * live run read it five times while building ever more elaborate
           * nested objects — its own thinking quoting the schema prose back
           * and guessing. A model that has misread a shape cannot be fixed by
           * being told the shape again in words.
           */
          throw new Error(
            'A plan needs at least one step. Copy this shape exactly:\n\n' +
              '  {"steps": ["Read the file and find the bug", "Fix it", "Run the tests"]}\n\n' +
              "A flat list of strings. Not objects, not numbered, not nested.",
          );
        }
        return say(`Plan set.\n${render(await setTasks(sessionId, steps))}${selfContainmentNote(steps)}`);
      },
    });

    /**
     * How we will know it worked, written down before the work starts.
     *
     * Ports the one field worth keeping from BirdClaw's task registry
     * (`memory/tasks.py`), which the audit dropped whole because the
     * `sessions` table supersedes the rest of it — correctly, except that
     * `expected_outcome` has no equivalent here. `tasks.result` is free text
     * written *after* a step, which is a report, not a criterion.
     *
     * The difference matters because of who reads it. A run that says "I have
     * completed the area function" is judged by that sentence and nothing
     * else; the supervisor asking "is this finished?" has the work and no
     * standard to hold it against, so it is judging plausibility. A criterion
     * fixed before the work turns that into a question with an answer — and
     * fixed *before* on purpose, since a standard written afterwards is
     * written by someone who already knows what they produced.
     *
     * It is deliberately not enforced. Nothing here can tell whether "the
     * tests pass" is true; the value is that the closing turn is asked the
     * question with the criterion in front of it, and that an unattended
     * routine's result becomes auditable rather than narrative.
     */
    pi.registerTool({
      name: "expected_outcome",
      label: "Say what done looks like",
      description:
        "Write down how you — or anyone else — will be able to tell this worked, before you start. " +
        "Something checkable: \"npm test -w server passes\", \"report.md has all five sections and " +
        "no TODOs\", \"the endpoint returns 200 for a valid key\". Not \"the code is better\". You " +
        "will be asked about it at the end, so write the thing you would actually check.",
      promptSnippet: "expected_outcome — say how you will know this worked, before starting",
      parameters: Type.Object({
        outcome: Type.String({ description: "The checkable condition, in one or two sentences." }),
      }),
      async execute(_id: string, p: any) {
        const outcome = String(p?.outcome ?? "").trim();
        if (!outcome) throw new Error("Nothing given — say what you would check to know this worked.");
        await updateSession(sessionId, { expected_outcome: outcome.slice(0, 1000) });
        return say(
          `Recorded. This work is done when: ${outcome}\n\n` +
            `You will be shown this again at the end and asked whether it is actually true.`,
        );
      },
    });

    pi.registerTool({
      name: "task_list",
      label: "Show plan",
      description: "See the current plan and which steps are done, in progress, or still to do.",
      promptSnippet: "task_list — see the current plan",
      async execute() {
        return say(render(await listTasks(sessionId)));
      },
      parameters: Type.Object({}),
    });

    pi.registerTool({
      name: "task_start",
      label: "Start step",
      description:
        "Mark the next pending step as the one you are working on. Call it before doing the work, so " +
        "anyone watching can see where you are.",
      promptSnippet: "task_start — begin the next step",
      parameters: Type.Object({}),
      async execute() {
        const next = await nextTask(sessionId);
        if (!next) {
          /**
           * A dead end that says so.
           *
           * This used to answer "Nothing pending — the plan is finished, or
           * there is no plan yet", which is true, reads as a success, and
           * suggests nothing. A learning-loop iteration read it and called
           * `task_start` about a hundred times in one turn: the answer never
           * changed, and nothing in it said that calling again could not help.
           */
          const plan = await listTasks(sessionId);
          /**
           * An error, not a polite success.
           *
           * This is the call that looped a hundred times in one turn. It
           * returned a *success* saying "nothing pending", which is true and
           * changes nothing — and the instruction to call it was still in the
           * prompt, unchanged, on the next generation. A tool that succeeds
           * without changing anything is a fixed point: the model's best next
           * action is the same call, forever.
           *
           * Thrown, so pi marks it `isError` and the model reads a failure it
           * has to route around rather than a result it can sit on.
           */
          throw new Error(
            plan.length
              ? `Every step of this plan is finished. Calling \`task_start\` again cannot change ` +
                `that — there is nothing left to start. Either write a new plan with \`task_plan\`, ` +
                `or say what you have concluded and stop.\n\n${render(plan)}`
              : `There is no plan, so there is no step to start. Calling \`task_start\` again will ` +
                `say the same thing. Write one with \`task_plan\` first, or do the work directly and ` +
                `say what came of it.`,
          );
        }
        await setTaskStatus(sessionId, next.seq, "running");
        return say(`Started [${next.seq}] ${next.description}`);
      },
    });

    pi.registerTool({
      name: "task_finish",
      label: "Finish step",
      description:
        "Record how a step turned out. Say what actually happened in `result` — a step marked done " +
        "with nothing to show for it tells the next iteration nothing. Mark it failed when it did not " +
        "work: a dead end recorded is a dead end nobody walks twice.",
      promptSnippet: "task_finish — record how a step turned out",
      parameters: Type.Object({
        step: Type.Number({ description: "The step's number, as shown in the plan." }),
        result: Type.String({ description: "What came of it, in a sentence." }),
        failed: Type.Optional(Type.Boolean({ description: "True if the step did not work out." })),
      }),
      async execute(_id: string, p: any) {
        const seq = Number(p.step);
        if (!Number.isInteger(seq)) throw new Error("Which step? Give the number shown in the plan.");

        /**
         * A step already closed by write_next keeps what write_next recorded.
         *
         * The two tools share the `tasks` table, which is deliberate — one
         * notion of "the steps I am working through". But `write_next` stores
         * *where the section landed in the file* (`212 chars @0-212`), and
         * that is what `read_section` and `write_revise` use to find it.
         * A model that writes a section and then also calls `task_finish` on
         * it — which one did, saying "the module has been written and
         * verified" — overwrites the span with prose, and the section quietly
         * becomes unreachable: not an error, just a later revise that reports
         * it cannot locate the text.
         *
         * The step is already done, so there is nothing to record. Say so.
         */
        const plan = await listTasks(sessionId);
        const current = plan.find((t: TaskRow) => t.seq === seq);
        if (current?.status === "done" && /@\d+-\d+$/.test(String(current.result ?? ""))) {
          // Showing the plan back matters here. In the run this came from, the
          // model's own two-step plan had been replaced by write_plan's four
          // sections without it being told, so "step 2" meant something to it
          // that it no longer meant here — and a refusal that did not say what
          // the plan now was left it retrying the same call.
          // Also a fixed point if it succeeds: nothing changes, so the same
          // call is as good a next action as any. See task_start above.
          throw new Error(
            `Step ${seq} ("${current.description}") was already written and recorded, so there is ` +
              `nothing to change and calling this again will say the same. The plan as it stands:` +
              `\n${render(plan)}`,
          );
        }

        /**
         * A section is not finished because the model says it is.
         *
         * Sisyphean's synthesizer carried a rule — never claim to have written
         * or run something unless a result says you did — and the audit filed
         * it as small-model scaffolding on the grounds that under pi the model
         * answering is the model that made the calls. Then a 26B model, asked
         * for the "area" section of a planned module, closed the step with
         * "I have completed the area function." and left the file empty.
         *
         * Here it is mechanical rather than a rule in a prompt. This session
         * is writing a document, this step is one of its sections, and
         * `write_next` records where each section landed. No span means no
         * text. There is nothing to interpret.
         */
        if (!p.failed) {
          const writingFile = (await getSession(sessionId))?.writing_file;
          if (writingFile && current && !/@\d+-\d+$/.test(String(current.result ?? ""))) {
            return say(
              `"${current.description}" is a section of ${writingFile}, and nothing has been written ` +
                `for it — the file does not contain it. Write it with \`write_next\`, which appends ` +
                `the text and closes the step for you.\n\nIf the section is genuinely not needed, ` +
                `\`write_skip\` says so with a reason. Marking it done leaves the plan claiming work ` +
                `the file does not have.`,
            );
          }
        }

        const row = await setTaskStatus(sessionId, seq, p.failed ? "failed" : "done", String(p.result ?? ""));
        if (!row) throw new Error(`There is no step ${seq} in this plan.`);
        return say(`${p.failed ? "Failed" : "Done"} [${seq}] ${row.description}\n\n${render(await listTasks(sessionId))}`);
      },
    });
  };
}
