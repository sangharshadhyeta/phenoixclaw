import { listSessions, type SessionRow } from "../db.js";

/**
 * What is running, in front of the conversation, every turn.
 *
 * `tasks_running` exists as a tool and that is not enough — by now the pattern
 * is well established here: a tool the model has to think to call is a tool it
 * does not call at the moment it matters. Asked "how is that going?" it would
 * answer from what it remembered starting.
 *
 * BirdClaw injects this instead (`soul_loop`, the active-task block): ids,
 * titles, status, how long they have been going, and what each was asked for.
 * With that in the prompt the conversation can answer "how is it going"
 * without a tool call, and — more importantly — can tell *which* of three
 * running tasks a follow-up belongs to.
 *
 * Only in a conversation. A task session is one of these; showing it a list of
 * its siblings is noise it cannot act on.
 */

const MARK: Record<string, string> = { running: "▸", idle: "✓", error: "✗", interrupted: "⏸" };

/** How long it has been going, coarsely — minutes matter, seconds do not. */
export function elapsed(since: string | undefined, now = Date.now()): string {
  if (!since) return "";
  /**
   * DuckDB's timestamps carry no zone, and `new Date` reads a bare one as
   * *local*. On a machine at +05:30 that made three minutes ago read as five
   * hours ago — wrong in the direction that matters, since the number exists
   * to tell you whether something is progressing or stuck.
   *
   * The database stores UTC (`now()` in the schema), so a bare timestamp is
   * given the zone it was written in. Anything that already carries one is
   * left alone.
   */
  const text = String(since).trim().replace(" ", "T");
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return "";
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}

/**
 * The block, or "" when there is nothing running and nothing recently done.
 *
 * Finished work is kept briefly on purpose: "did that work?" arrives just
 * after something finished, and a list that drops a task the moment it settles
 * cannot answer it.
 */
export function tasksBlock(sessions: SessionRow[], now = Date.now()): string {
  const mine = sessions.filter((s) => s.kind === "task" && s.started_by);
  const active = mine.filter((s) => s.status === "running");
  const recent = mine
    .filter((s) => s.status !== "running")
    .slice(0, 4);
  if (!active.length && !recent.length) return "";

  const line = (s: SessionRow) =>
    `${MARK[s.status] ?? "·"} [${s.id}] "${s.title}"` +
    (s.status === "running" ? ` — running ${elapsed(s.updated_at, now)}` : ` — ${s.status}`) +
    (s.status === "error" && s.last_error ? `: ${s.last_error.slice(0, 100)}` : "");

  return [
    "",
    "# WORK YOU HAVE HANDED OUT",
    "",
    ...(active.length ? ["Still going:", ...active.map(line)] : []),
    ...(recent.length ? ["", "Finished:", ...recent.map(line)] : []),
    "",
    "You can answer questions about these without asking anyone. If something is said that belongs",
    "to one of them — a correction, an extra requirement, a change of mind — send it there with",
    "`tell_task` rather than starting a new one or answering as though the work were yours to do.",
  ].join("\n");
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

function messagesOf(payload: unknown): any[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.every((m) => typeof m === "object" && m !== null && typeof (m as any).role === "string")
    ? messages
    : undefined;
}

export function tasksContext(load: () => Promise<SessionRow[]> = listSessions) {
  return (pi: any): void => {
    pi.on("before_provider_request", async (event: any) => {
      const payload = event?.payload;
      const messages = messagesOf(payload);
      if (!messages) return undefined;

      let block = "";
      try {
        block = tasksBlock(await load());
      } catch {
        // Not knowing what is running must not stop the conversation.
      }
      if (!block) return undefined;

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
