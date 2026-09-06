import type { PortalEvent } from "./api";

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      detail?: string;
      /** What the tool actually returned, so a run can be read back afterwards. */
      result?: string;
      /** Milliseconds from start to end, when both were seen. */
      ms?: number;
      /** Set when the call was matched by id rather than by name — see below. */
      callId?: string;
    }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" }
  /**
   * Work from another session, shown here so one place tells you what the
   * agent is doing. `said` distinguishes what it wrote from what it ran, and
   * `asked` is somebody's request in a task session — both look wrong rendered
   * as ordinary turns, because neither was said to the reader.
   */
  | {
      kind: "self";
      id: string;
      source: string;
      text: string;
      phase?: "start" | "end";
      mode?: "tool" | "said" | "asked";
    }
  /**
   * A run of consecutive lines from one other session, folded into one entry.
   *
   * Without this the main conversation is a flat interleave: three sessions
   * working at once produce lines that alternate between them, and following
   * any single thread means reading past the other two. Grouping restores the
   * thread while keeping the one-stream view the mirror is for.
   */
  | { kind: "thread"; id: string; source: string; items: Extract<Item, { kind: "self" }>[] };

/**
 * Fold pi's event stream into renderable turns.
 *
 * Deliberately tolerant: pi emits more event types than we render, and shapes
 * vary by version. Anything unrecognised is skipped rather than breaking the
 * transcript — a task that ran fine shouldn't look broken because of one
 * unexpected field.
 */
export function buildTranscript(events: PortalEvent[]): Item[] {
  const items: Item[] = [];
  let current: Extract<Item, { kind: "assistant" }> | null = null;
  /** When each tool call began, so a card can say how long it took. */
  const startedAt = new Map<string, string>();

  const closeCurrent = () => {
    if (current) {
      current.done = true;
      current = null;
    }
  };

  for (const ev of events) {
    const p = ev.payload ?? {};
    switch (ev.type) {
      /**
       * A routine's milestone, shown in the agent's own conversation.
       *
       * Rendered as its own kind rather than folded into the assistant turns
       * around it: this was not said to the reader, and a transcript that
       * blurs "what it told you" into "what it was doing on its own" is
       * exactly the confusion the mirror exists to avoid.
       */
      case "mirrored": {
        closeCurrent();
        const inner = p.payload ?? {};
        const source = String(p.source ?? "routine");
        if (p.type === "portal_routine") {
          const phase = inner.phase === "end" ? "end" : "start";
          items.push({
            kind: "self",
            id: `m${ev.seq}`,
            source: String(inner.routine ?? source),
            phase,
            text: phase === "end" ? String(inner.summary ?? "") : "",
          });
          break;
        }
        if (p.type === "tool_execution_start") {
          items.push({
            kind: "self",
            id: `m${ev.seq}`,
            source,
            mode: "tool",
            text: `${String(inner.toolName ?? inner.name ?? "tool")}${
              summarizeToolInput(inner) ? ` — ${summarizeToolInput(inner)}` : ""
            }`,
          });
          break;
        }
        /**
         * What was asked, and what came back.
         *
         * Both were being mirrored and neither was rendered, so the main
         * conversation showed a stream of tool names with no sense of what any
         * of it was for — "read, grep, edit" with nothing saying why. The task
         * a person started is the most useful line in the whole mirror.
         */
        if (p.type === "portal_prompt" && typeof inner.message === "string" && inner.message.trim()) {
          items.push({ kind: "self", id: `m${ev.seq}`, source, mode: "asked", text: inner.message.trim() });
          break;
        }
        if (p.type === "message_end") {
          const said = typeof inner.text === "string" ? inner.text.trim() : "";
          if (said) items.push({ kind: "self", id: `m${ev.seq}`, source, mode: "said", text: said });
        }
        break;
      }

      case "portal_prompt":
        closeCurrent();
        items.push({ kind: "user", id: `u${ev.seq}`, text: String(p.message ?? "") });
        break;

      /**
       * A brief the portal wrote for one step of a plan.
       *
       * Not a user message — rendering it as one put a wall of generated
       * instructions in the transcript looking like something the person had
       * typed. Shown as a notice with its first line, which is enough to see
       * which step is running; the whole brief is in the event log.
       */
      /**
       * A task's answer, arriving in the conversation that asked for it.
       *
       * Rendered as the agent speaking rather than as a notice, because that
       * is what it is: the person asked for something, the agent handed it to
       * a session of its own, and this is the reply. A notice would file the
       * answer under housekeeping.
       */
      /**
       * Work was handed out. Said here rather than left to the model.
       *
       * The tool's result reaches the model, not the person, so whether the
       * chat mentioned a session had started depended on the model choosing
       * to say so — and a session starting is a thing that happened, which
       * belongs in the transcript as one. Named, so you know which of the
       * sessions on the left it is.
       */
      case "portal_task_started": {
        closeCurrent();
        const title = String(p.title ?? "work");
        items.push({
          kind: "notice",
          id: `ts${ev.seq}`,
          text: `Started "${title}" as its own session — it runs on its own and answers here.`,
          tone: "info",
        });
        break;
      }

      case "portal_task_result": {
        closeCurrent();
        const text = String(p.text ?? "").trim();
        if (!text) break;
        items.push({
          kind: "assistant",
          id: `r${ev.seq}`,
          text: `**${String(p.title ?? "task")}** — finished.\n\n${text}`,
          thinking: "",
          done: true,
        });
        break;
      }

      /**
       * The transcript was cleared. Everything before this point is gone from
       * the database; a live viewer has it in memory and must drop it too, or
       * the chat looks unchanged until the page is reloaded.
       */
      case "portal_cleared":
        items.length = 0;
        current = null;
        break;

      case "portal_step": {
        closeCurrent();
        const brief = String(p.message ?? "");
        const step = /^# THIS STEP\n+(.+)$/m.exec(brief)?.[1]?.trim();
        /**
         * A routine's own prompt comes through here too, and it is framing
         * written for the model — the `<routine>` block, then the whole
         * instruction set. Rendering it verbatim put a page of prompt in the
         * transcript as though somebody had typed it. One line is what a
         * reader wants: this woke up.
         */
        const routine = /<routine name="([^"]+)"/.exec(brief)?.[1];
        const checked = /<portal-check>/.test(brief);
        items.push({
          kind: "notice",
          id: `s${ev.seq}`,
          text: routine
            ? `${routine} — woken by its schedule.`
            : checked
              ? "Checking the last answer."
              : step
                ? `Working on: ${step}`
                : "Working the plan",
          tone: "info",
        });
        break;
      }

      case "message_update": {
        const inner = p.assistantMessageEvent ?? {};
        const delta = typeof inner.delta === "string" ? inner.delta : "";
        if (!delta) break;
        if (!current) {
          current = { kind: "assistant", id: `a${ev.seq}`, text: "", thinking: "", done: false };
          items.push(current);
        }
        if (inner.type === "thinking_delta") current.thinking += delta;
        else if (inner.type === "text_delta") current.text += delta;
        break;
      }

      /**
       * The finished turn, for a reader who never saw it arrive.
       *
       * `message_update` is no longer stored — it was one row per token and it
       * grew the database past a gigabyte (see EPHEMERAL_EVENTS in
       * session-manager.ts). Live viewers still get the deltas and build the
       * item from them, in which case `current` exists and this only closes
       * it. A replay has no deltas at all, so the item has to be built here
       * from the whole message, or a reloaded conversation shows tool calls
       * with nothing said between them.
       */
      case "message_end": {
        if (current) {
          closeCurrent();
          break;
        }
        const message = p.message as { role?: string; content?: unknown } | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) break;
        let text = "";
        let thinking = "";
        for (const part of message.content as any[]) {
          if (part?.type === "text" && typeof part.text === "string") text += part.text;
          else if (part?.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
        }
        if (!text.trim() && !thinking.trim()) break;
        items.push({ kind: "assistant", id: `a${ev.seq}`, text, thinking, done: true });
        break;
      }

      case "tool_execution_start":
        closeCurrent();
        items.push({
          kind: "tool",
          id: `t${ev.seq}`,
          name: String(p.toolName ?? p.name ?? "tool"),
          status: "running",
          detail: summarizeToolInput(p),
          callId: typeof p.toolCallId === "string" ? p.toolCallId : undefined,
        });
        startedAt.set(String(p.toolCallId ?? `${p.toolName}-${ev.seq}`), ev.at ?? "");
        break;

      case "tool_execution_end": {
        /**
         * Paired by call id where pi gives one, by name only as a fallback.
         *
         * Tools run in parallel — pi's default — so "the most recent running
         * tool of the same name" is a guess, and with two reads in flight it
         * is a coin toss which card gets which result. The id is exact.
         */
        const name = String(p.toolName ?? p.name ?? "tool");
        const callId = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind !== "tool" || it.status !== "running") continue;
          if (callId ? it.callId !== callId : it.name !== name) continue;

          it.status = p.isError || p.error ? "error" : "done";
          /**
           * The result itself, kept.
           *
           * This is the single largest thing missing from the transcript: a
           * finished run showed which tools were reached for and nothing about
           * what any of them found, so reading back what happened meant opening
           * the database. BirdClaw's `cards.py` is 522 lines of exactly this,
           * and it is what makes a run legible.
           */
          it.result = resultText(p);
          const began = startedAt.get(callId ?? `${name}-unknown`);
          if (began && ev.at) {
            const ms = new Date(ev.at).getTime() - new Date(began).getTime();
            if (Number.isFinite(ms) && ms >= 0) it.ms = ms;
          }
          break;
        }
        break;
      }

      // Output from a builtin like /session or /compact — pi never saw it.
      case "portal_notice":
        items.push({
          kind: "notice",
          id: `n${ev.seq}`,
          text: String(p.text ?? ""),
          tone: p.error ? "error" : "info",
        });
        break;

      case "portal_status":
        if (p.status === "error" && p.error) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: String(p.error), tone: "error" });
        }
        if (p.status === "idle" && p.aborted) {
          items.push({ kind: "notice", id: `n${ev.seq}`, text: "Aborted", tone: "info" });
        }
        break;

      case "agent_end":
        closeCurrent();
        break;

      default:
        break;
    }
  }

  // Anything still open belongs to a run in flight.
  return group(items);
}

/**
 * Fold consecutive `self` lines from the same source into one thread.
 *
 * Only consecutive ones: a run interrupted by something you said, or by another
 * session, starts a new group. That keeps the ordering honest — a thread here
 * means "these happened together", not "these happened at some point".
 *
 * A single line is left alone. Wrapping one mirrored tool call in a collapsible
 * header costs a click and saves nothing.
 */
function group(items: Item[]): Item[] {
  const out: Item[] = [];
  let run: Extract<Item, { kind: "self" }>[] = [];

  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) out.push(run[0]);
    else out.push({ kind: "thread", id: `t${run[0].id}`, source: run[0].source, items: run });
    run = [];
  };

  for (const item of items) {
    if (item.kind === "self" && (!run.length || run[0].source === item.source)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "self") run.push(item);
    else out.push(item);
  }
  flush();
  return out;
}

/**
 * A tool's output as text.
 *
 * pi returns content as an array of parts, the same shape the mirror had to
 * learn about. Capped generously — a card is for reading, and a file that runs
 * to thousands of lines is better truncated here than sent to the browser in
 * full on every replay.
 */
function resultText(p: any): string | undefined {
  const content = p?.result?.content ?? p?.content ?? p?.result;
  const text = Array.isArray(content)
    ? content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("")
    : typeof content === "string"
      ? content
      : undefined;
  if (!text) return undefined;
  const trimmed = text.trim();
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…` : trimmed;
}

/**
 * A short subject for a tool call, or nothing.
 *
 * Nothing is a real answer here. Several tools take no arguments at all —
 * `self_review`, `task_list`, `task_start` — and this rendered their empty
 * object as the literal string `{}`, so the transcript read
 * "self_review — {}". A card that says nothing about its arguments is correct
 * for a tool that has none; punctuation standing in for content is not.
 */
function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  if (typeof input === "string") return truncate(input) || undefined;
  if (typeof input !== "object") return undefined;

  const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
  if (typeof first === "string") return truncate(first) || undefined;

  // A plan is its steps; showing `[object Object]` or raw JSON is worse than
  // the first step and a count.
  if (Array.isArray(input.steps) || Array.isArray(input.sections)) {
    const parts = (input.steps ?? input.sections).map((x: unknown) =>
      typeof x === "string" ? x : "",
    ).filter(Boolean);
    if (parts.length) {
      return truncate(parts.length > 1 ? `${parts[0]} (+${parts.length - 1} more)` : parts[0]);
    }
  }

  const keys = Object.keys(input);
  if (!keys.length) return undefined;
  const rendered = truncate(JSON.stringify(input));
  return rendered && rendered !== "{}" ? rendered : undefined;
}

function truncate(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Highest seq seen, so a reconnect resumes exactly where the stream left off. */
export function lastSeq(events: PortalEvent[]): number {
  return events.length ? events[events.length - 1].seq : 0;
}
