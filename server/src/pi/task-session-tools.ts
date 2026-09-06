import { Type } from "typebox";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSession, getSession, listSessions } from "../db.js";

/**
 * Starting a piece of work that is not this conversation.
 *
 * The portal had no way for the agent to do this. Sessions were created by a
 * person, through a form, with a title they typed and a workspace they picked
 * — so every substantial task had to be set up by hand before the agent could
 * begin, and the conversation you were having and the work you were asking for
 * were the same window.
 *
 * BirdClaw had it the other way round and it is the better shape: the chat is
 * one place you talk to the agent, and the agent decides when something has
 * become a task, gives it an id and a workspace of its own, and reports back.
 * You get an answer in the conversation; the working lives somewhere you can
 * open if you want it and do not have to.
 *
 * ## Why the agent chooses the id and the directory
 *
 * Because it can do both correctly and a person cannot be asked to. Titles
 * collide — "notes" twice is two pieces of work in one folder — and the
 * isolation the guard enforces is only as good as the directory it is given.
 * Naming from the id is what makes "this session may write here and nowhere
 * else" a statement about something real.
 *
 * ## Fire and forget, like everything else here
 *
 * This returns as soon as the work is accepted, not when it is done. The run
 * belongs to the server: the conversation that started it can end, the browser
 * can close, and the task carries on. Its answer arrives back in the main
 * conversation when it has one.
 */

export interface TaskSessionDeps {
  /** The conversation handing the work out, recorded so the answer knows where to go. */
  parentSessionId: string;
  workspaceRoot: string;
  executor: string;
  newId: () => string;
  /** Prompt the new session. Not awaited by the tool — see fire and forget. */
  start: (sessionId: string, instructions: string) => Promise<unknown>;
  /**
   * Say in the conversation that work was handed out.
   *
   * The tool's own result reaches the model, not the person — so whether the
   * chat mentioned it at all depended on the model choosing to. A session
   * starting is a thing that happened, and belongs in the transcript as one.
   */
  announce?: (event: { sessionId: string; title: string; workspace: string }) => Promise<void>;
}

/** A directory named from the id, which is unique, rather than the title, which is not. */
export function workspaceFor(root: string, id: string): string {
  return path.join(root, `session-${id}`);
}

/**
 * Create the session, announce it, and set it running.
 *
 * Split out of the tool because the portal starts work on its own now, without
 * waiting for the model to choose to — see `handOutForRequest` in
 * session-manager.ts. Both paths must produce exactly the same thing: the same
 * id scheme, the same workspace boundary, the same `started_by` so the answer
 * knows which conversation to come back to.
 */
export async function handOut(
  deps: TaskSessionDeps,
  title: string,
  instructions: string,
): Promise<{ id: string; workspace: string }> {
  const id = deps.newId();
  const workspace = workspaceFor(deps.workspaceRoot, id);
  mkdirSync(workspace, { recursive: true });
  await createSession({
    id,
    title: title.slice(0, 120),
    workspace,
    executor: deps.executor,
    // Which conversation to answer. A session a person created has none, and
    // its answer is not relayed anywhere — they are looking at it.
    started_by: deps.parentSessionId,
  });
  await deps.announce?.({ sessionId: id, title: title.slice(0, 120), workspace });
  // Not awaited: this returns when the work is accepted, not when it is
  // finished. Awaiting would block the conversation for as long as the task
  // takes, which is the arrangement this exists to end.
  void deps.start(id, instructions);
  return { id, workspace };
}

export function taskSessionTools(deps: TaskSessionDeps) {
  return (pi: any): void => {
    pi.registerTool({
      name: "start_task",
      label: "Start a task",
      description:
        "Hand a piece of work to a session of its own, with its own workspace, and carry on here. " +
        "Use it when what has been asked for is work rather than an answer — building something, " +
        "researching something properly, anything that will take more than this reply.\\n\\n" +
        "Write `instructions` for someone who cannot see this conversation: what to do, what " +
        "counts as done, and any detail you have that they would otherwise have to ask for. They " +
        "get a fresh context and an empty directory, not your memory of what was said.\\n\\n" +
        "It starts immediately and runs on its own. You do not wait for it — say what you have " +
        "started and what you expect from it. Its answer comes back here when it has one.",
      promptSnippet: "start_task — hand work to a session of its own",
      parameters: Type.Object({
        title: Type.String({ description: "A few words naming the work, for the session list." }),
        instructions: Type.String({
          description: "The whole brief, written for someone who was not part of this conversation.",
        }),
      }),
      async execute(_id: string, p: any) {
        const title = String(p?.title ?? "").trim();
        const instructions = String(p?.instructions ?? "").trim();
        if (!title) throw new Error("Give the work a short title.");
        if (instructions.length < 20) {
          throw new Error(
            "The instructions are too short to act on. The session that reads them cannot see this " +
              "conversation — say what to do and what counts as done.",
          );
        }
        const { id, workspace } = await handOut(deps, title, instructions);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Started "${title}" as its own session (${id}), working in ${workspace}.\\n\\n` +
                `It is running now and you are not waiting for it. Tell the person what you have ` +
                `set going and what you expect back; its answer will arrive here when it has one.`,
            },
          ],
          details: { sessionId: id },
        };
      },
    });

    /**
     * A follow-up belongs to the work it is about.
     *
     * "Actually make it handle negative numbers too" is not a new task and it
     * is not something the conversation can do — the work is happening in a
     * session with its own context, its own plan and its own workspace, and
     * that is where the correction has to land. Without this the conversation
     * could only start a second task or answer as though the work were its
     * own, both of which lose the correction.
     */
    pi.registerTool({
      name: "tell_task",
      label: "Send to a running task",
      description:
        "Send something to work you have already handed out — a correction, an extra requirement, " +
        "a change of mind, or a question about it. Use it whenever what has just been said belongs " +
        "to a task that is already running rather than being new work.\n\n" +
        "The session it goes to has its own context and cannot see this conversation, so say the " +
        "whole thing: what to change and why, not \"as we discussed\".",
      promptSnippet: "tell_task — send a correction or addition to work already running",
      parameters: Type.Object({
        session: Type.String({ description: "The task's id, as shown in the list of work you have handed out." }),
        message: Type.String({ description: "The whole message, written for a session that cannot see this one." }),
      }),
      async execute(_id: string, p: any) {
        const target = String(p?.session ?? "").trim();
        const message = String(p?.message ?? "").trim();
        if (!target) throw new Error("Which task? Give the id shown in the list of work you have handed out.");
        if (message.length < 10) {
          throw new Error(
            "Too short to act on. The session cannot see this conversation — say what to change and why.",
          );
        }

        const row = await getSession(target);
        if (!row) throw new Error(`There is no session ${target}.`);
        if (row.kind !== "task") {
          throw new Error(`${target} is not work you handed out — it is a ${row.kind} session.`);
        }

        // Not awaited, like start_task: the conversation carries on, and the
        // task's answer comes back when it has one.
        void deps.start(target, message);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Sent to "${row.title}" (${target}). It will pick this up on its next turn and its ` +
                `answer comes back here. Say what you have passed on.`,
            },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "tasks_running",
      label: "What is in progress",
      description:
        "See the work you have started that is still going, and what has finished since. Use it " +
        "when asked how something is coming along, rather than guessing from what you remember " +
        "starting.",
      promptSnippet: "tasks_running — see the work you have started",
      parameters: Type.Object({}),
      async execute() {
        const rows = (await listSessions()).filter((s) => s.kind === "task");
        if (!rows.length) {
          return { content: [{ type: "text" as const, text: "Nothing started." }], details: {} };
        }
        const line = (s: (typeof rows)[number]) =>
          `${s.status === "running" ? "▸" : s.status === "error" ? "✗" : "✓"} ${s.title} (${s.id})` +
          (s.status === "error" && s.last_error ? ` — ${s.last_error.slice(0, 120)}` : "");
        return {
          content: [{ type: "text" as const, text: rows.slice(-12).map(line).join("\\n") }],
          details: {},
        };
      },
    });
  };
}

/** Exported for the contract: what `start_task` refuses. */
export function briefIsUsable(instructions: string): boolean {
  return instructions.trim().length >= 20;
}

export { getSession };
