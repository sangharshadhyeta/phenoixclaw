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
export const isMirrorable = (type: string): boolean =>
  type === "portal_prompt" ||
  type === "message_end" ||
  type === "tool_execution_start" ||
  type === "tool_execution_end" ||
  type === "portal_routine";

/**
 * Show something a routine did in the main conversation.
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
  const row = await appendEvent(target, "mirrored", {
    source: source.slug,
    sourceSessionId: source.sessionId,
    type,
    payload,
  });
  return { sessionId: target, row };
}
