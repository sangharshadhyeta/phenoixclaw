import { nanoid } from "nanoid";
import { appendEvent, findChannelSession, createSession } from "./db.js";
import { agentHome, scopeKey } from "./agent.js";

/**
 * One conversation, nothing hidden.
 *
 * A routine runs in its own session, which is right for its *context* — the
 * learning loop turns over every minute and the dream cycle is eight phases,
 * and sharing one window with the person the agent works for would compact
 * their conversation away to make room for its own thinking. But a run nobody
 * can see contradicts the constitution's transparency clause as squarely as
 * anything does: "what you did is visible, not hidden from the person who runs
 * you."
 *
 * So the run keeps its own context and its milestones are *mirrored* into the
 * agent's main conversation as they happen. The split is possible because the
 * portal's `events` table is a display and audit log, not the model's memory —
 * pi keeps its own session file for that. Writing a row here shows the user
 * something; it puts nothing into anybody's context window. Visibility is
 * free; sharing a context is not.
 *
 * What arrives is milestones, not the stream: a run's start and end, what it
 * said, and what it did. Mirroring every token would bury a conversation under
 * an inner monologue that never stops, which is hiding by volume.
 */

/**
 * The agent's own conversation — the one the mirror writes into and the one a
 * person types into to interrupt.
 *
 * A reserved key rather than "whichever chat is open": the mirror has to go
 * somewhere stable, or the record of what the agent did while you were away
 * depends on which tab you had open when it did it.
 */
const MAIN_KEY = scopeKey("browser", "main");

let mainSessionId: string | null = null;

/** The main conversation, created the first time anything needs it. */
export async function mainConversation(executor: string): Promise<string> {
  if (mainSessionId) return mainSessionId;
  const existing = await findChannelSession(MAIN_KEY);
  if (existing) {
    mainSessionId = existing.id;
    return mainSessionId;
  }
  const id = nanoid(12);
  await createSession({
    id,
    title: "Agent",
    workspace: agentHome(),
    executor,
    kind: "agent",
    channel_slug: "browser",
    channel_key: MAIN_KEY,
  });
  mainSessionId = id;
  return id;
}

/** True for the events worth showing — boundaries and results, not deltas. */
/**
 * What reaches the main conversation.
 *
 * `tool_execution_end` is deliberately absent, and its removal is the whole
 * re-budget. It carries the tool's *result* — a file's contents, a page, a
 * directory listing — and once task sessions mirror as well as routines, that
 * is the entire working output of every session in the portal landing in one
 * place. Which is the failure this module already names: "mirroring every token
 * would bury a conversation under an inner monologue that never stops, which is
 * hiding by volume."
 *
 * What is left is the shape of the work rather than its substance: what was
 * asked, what the agent said back, which tools it reached for, and the bookends
 * of a routine run. Enough to follow along and to notice something going wrong;
 * the session's own transcript is one click away for the rest.
 */
export const isMirrorable = (type: string): boolean =>
  type === "portal_prompt" ||
  type === "message_end" ||
  type === "tool_execution_start" ||
  type === "portal_routine" ||
  // A finished task's answer. Everything else mirrored is a notice that
  // something happened; this is the thing itself, which is why it is exempt
  // from the clip below — see mirrorResult.
  type === "portal_task_result";

/** Enough of a message to follow the thread; the source session has all of it. */
const MIRRORED_TEXT = 500;

/**
 * The assistant's own words out of a `message_end`, or nothing.
 *
 * pi emits `message_end` for every message in the exchange, not only the
 * agent's: a `user` role for the prompt and a `toolResult` role carrying a
 * tool's entire output. Mirroring those put every file the agent read back into
 * the main conversation through the side door — the exact bulk removing
 * `tool_execution_end` was meant to keep out, arriving under a different name.
 *
 * `content` is an array of parts rather than a string, which is why the first
 * version of this quietly matched nothing and let all of it through.
 */
function assistantText(p: Record<string, unknown>): { text: string } | undefined {
  const message = p.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant") return undefined;

  const content = message.content;
  const text = Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
            ? String((part as Record<string, unknown>).text ?? "")
            : "",
        )
        .join("")
        .trim()
    : typeof content === "string"
      ? content.trim()
      : "";
  return text ? { text: clip(text, MIRRORED_TEXT) } : undefined;
}

/**
 * Keep the shape, drop the bulk.
 *
 * A mirrored line is a *notice* that something happened, not a copy of it. An
 * assistant message can be pages long and a tool's arguments can be a whole
 * file, and neither belongs in a conversation that is trying to show a dozen
 * sessions at once.
 */
function trim(type: string, payload: unknown): unknown | undefined {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;

  /**
   * The one thing that arrives whole.
   *
   * Every other mirrored line is a notice that something happened, clipped so
   * a conversation watching a dozen sessions stays readable. A task's answer
   * is not a notice — it is what was asked for, and the whole point of the
   * chat being one place is that the result appears there rather than in a
   * window you have to go and find. Clipping it to 500 characters would make
   * the main conversation a place that tells you your answer exists.
   */
  if (type === "portal_task_result") return p;

  if (type === "portal_prompt" && typeof p.message === "string") {
    return { ...p, message: clip(p.message, MIRRORED_TEXT) };
  }
  if (type === "tool_execution_start") {
    // The name and a short subject — "read src/index.ts" reads at a glance
    // where whole arguments do not. The *shape* is preserved (`args` stays
    // `args`) because the web transcript's summarizeToolInput reads it; only
    // the size changes.
    const args = (p.args ?? p.input ?? {}) as Record<string, unknown>;
    const first = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query;
    return {
      toolName: p.toolName ?? p.name,
      args: typeof first === "string" ? { command: clip(first, 120) } : {},
    };
  }
  if (type === "message_end") return assistantText(p);
  return p;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Show something a session did in the main conversation.
 *
 * Wrapped in its own event type rather than replayed as the original, so the
 * transcript can render it as something the agent did on its own initiative
 * rather than as part of the conversation it is mirrored into. A reader should
 * never have to wonder whether they said that.
 */
export async function mirror(
  executor: string,
  source: { slug: string; sessionId: string },
  type: string,
  payload: unknown,
): Promise<{ sessionId: string; row: unknown } | undefined> {
  if (!isMirrorable(type)) return undefined;
  const target = await mainConversation(executor);
  // Never mirror the main conversation into itself.
  if (target === source.sessionId) return undefined;
  // Nothing worth showing — a tool result, or the user's own message coming
  // back as a message_end. Dropped rather than stored empty.
  const trimmed = trim(type, payload);
  if (trimmed === undefined) return undefined;

  const row = await appendEvent(target, "mirrored", {
    source: source.slug,
    sourceSessionId: source.sessionId,
    type,
    payload: trimmed,
  });
  return { sessionId: target, row };
}
