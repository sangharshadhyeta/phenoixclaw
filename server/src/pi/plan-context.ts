import { getSession, listTasks, type TaskRow } from "../db.js";

/**
 * Put the plan back in front of the model on every request.
 *
 * `task_plan` and `write_plan` write a checklist, and then nothing shows it
 * again. The plan reached the model exactly once — as the tool result of the
 * call that wrote it — and after that it survived only as far back as the
 * conversation window happened to reach. `task_list` exists, but it is a tool
 * the model has to *think* to call, and the moment it has forgotten there is a
 * plan is precisely the moment it will not call it. The UI reads the table
 * directly, so the plan was visible to the person watching and invisible to the
 * one working.
 *
 * The context assembler makes that worse rather than better: past
 * KEEP_EXCHANGES it drops the older messages outright, so a long piece of work
 * loses the plan it wrote at the start of it — the exact case the plan is for.
 *
 * So it goes in the system prompt, rebuilt per provider request rather than per
 * turn. Per turn is not enough: `task_start` and `task_finish` fire *inside* a
 * turn, and the point is that the model knows which step it is on after twenty
 * tool calls, not only at the top of the message.
 *
 * Appended to the system prompt rather than inserted as a message, for the same
 * reason context-assembler.ts gives: a synthetic turn mid-conversation reads as
 * something somebody said, and this is not that.
 */

const MARK: Record<string, string> = { pending: "·", running: "▸", done: "✓", failed: "✗" };

/** True when this looks like a chat-completions body we understand. */
function messagesOf(payload: unknown): any[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.every((m) => typeof m === "object" && m !== null && typeof (m as any).role === "string")
    ? messages
    : undefined;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as any).text ?? "") : ""))
      .join(" ");
  }
  return "";
};

/**
 * The block, or "" when there is no plan worth showing.
 *
 * A finished plan is dropped rather than shown as a wall of ticks: once every
 * step is done it is history, and history belongs in the transcript.
 */
export function planBlock(tasks: TaskRow[], file?: string | null): string {
  if (!tasks.length) return "";
  const open = tasks.filter((t) => t.status === "pending" || t.status === "running");
  if (!open.length) return "";

  const running = tasks.find((t) => t.status === "running");
  const next = tasks.find((t) => t.status === "pending");

  return [
    "",
    "# THE PLAN YOU WROTE",
    "",
    file ? `You are writing ${file}, a section at a time.` : "This is your own checklist for the work in hand.",
    "",
    ...tasks.map((t) => `${MARK[t.status] ?? "·"} [${t.seq}] ${t.description}${t.result ? ` — ${t.result}` : ""}`),
    "",
    running
      ? `You are on step ${running.seq}. Call task_finish when it is done, with what actually came of it.`
      : next
        ? `Nothing is in progress. Step ${next.seq} is next${file ? " — `write_next` writes it" : ""}.`
        : "",
    "Revise it with " +
      (file ? "`write_plan`" : "`task_plan`") +
      " if what you have found changes what should happen next; that is expected, not a failure.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** What the block is built from. Injected so the contract need not open a database. */
export type PlanLoader = (sessionId: string) => Promise<{ tasks: TaskRow[]; file?: string | null }>;

const fromDb: PlanLoader = async (sessionId) => {
  const [tasks, session] = await Promise.all([listTasks(sessionId), getSession(sessionId)]);
  return { tasks, file: session?.writing_file };
};

export function planContext(sessionId: string | undefined, load: PlanLoader = fromDb) {
  return (pi: any): void => {
    if (!sessionId) return;
    pi.on("before_provider_request", async (event: any) => {
      const payload = event?.payload;
      const messages = messagesOf(payload);
      if (!messages) return undefined;

      let block = "";
      try {
        const { tasks, file } = await load(sessionId);
        block = planBlock(tasks, file);
      } catch {
        /* the plan being unreadable must not break the request */
      }
      if (!block) return undefined;

      // Only the leading system messages are the prompt; a `system` role
      // further down belongs to the conversation.
      const first = messages[0];
      if (!first || first.role !== "system") {
        return { ...(payload as object), messages: [{ role: "system", content: block }, ...messages] };
      }
      return {
        ...(payload as object),
        messages: [{ ...first, content: `${textOf(first.content)}\n${block}` }, ...messages.slice(1)],
      };
    });
  };
}
