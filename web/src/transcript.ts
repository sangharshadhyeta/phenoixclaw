import type { PortalEvent } from "./api";

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; done: boolean }
  | { kind: "tool"; id: string; name: string; status: "running" | "done" | "error"; detail?: string }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" }
  /** Something the agent did on its own initiative, mirrored in from a routine. */
  | { kind: "self"; id: string; source: string; text: string; phase?: "start" | "end" };

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
            text: `${String(inner.toolName ?? inner.name ?? "tool")}${
              summarizeToolInput(inner) ? ` — ${summarizeToolInput(inner)}` : ""
            }`,
          });
        }
        break;
      }

      case "portal_prompt":
        closeCurrent();
        items.push({ kind: "user", id: `u${ev.seq}`, text: String(p.message ?? "") });
        break;

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

      case "message_end":
        closeCurrent();
        break;

      case "tool_execution_start":
        closeCurrent();
        items.push({
          kind: "tool",
          id: `t${ev.seq}`,
          name: String(p.toolName ?? p.name ?? "tool"),
          status: "running",
          detail: summarizeToolInput(p),
        });
        break;

      case "tool_execution_end": {
        // Close the most recent still-running tool of the same name.
        const name = String(p.toolName ?? p.name ?? "tool");
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.status === "running" && it.name === name) {
            it.status = p.isError || p.error ? "error" : "done";
            break;
          }
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
  return items;
}

function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  if (typeof input === "string") return truncate(input);
  if (typeof input === "object") {
    const first =
      input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof first === "string") return truncate(first);
    return truncate(JSON.stringify(input));
  }
  return undefined;
}

function truncate(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Highest seq seen, so a reconnect resumes exactly where the stream left off. */
export function lastSeq(events: PortalEvent[]): number {
  return events.length ? events[events.length - 1].seq : 0;
}
