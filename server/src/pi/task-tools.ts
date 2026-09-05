import { Type } from "typebox";
import { listTasks, nextTask, setTaskStatus, setTasks, type TaskRow } from "../db.js";

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
        "so repeat them unchanged if they still belong in the plan.",
      promptSnippet: "task_plan — write or revise the steps for this work",
      parameters: Type.Object({
        steps: Type.Array(Type.String(), { description: "One short line per step, in order." }),
      }),
      async execute(_id: string, p: any) {
        const steps = Array.isArray(p.steps) ? p.steps.map(String) : [];
        if (!steps.length) throw new Error("A plan needs at least one step.");
        return say(`Plan set.\n${render(await setTasks(sessionId, steps))}`);
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
        if (!next) return say("Nothing pending — the plan is finished, or there is no plan yet.");
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
        const row = await setTaskStatus(sessionId, seq, p.failed ? "failed" : "done", String(p.result ?? ""));
        if (!row) throw new Error(`There is no step ${seq} in this plan.`);
        return say(`${p.failed ? "Failed" : "Done"} [${seq}] ${row.description}\n\n${render(await listTasks(sessionId))}`);
      },
    });
  };
}
