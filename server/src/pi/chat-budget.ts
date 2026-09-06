/**
 * How much a conversation may do before it has to hand the work out.
 *
 * The after-turn check catches a chat that did the work itself, and a live run
 * showed the limit of catching: it fired, the model read "hand it out next
 * time", and simply answered anyway. That is the fourth rule reasoned past
 * today, and it teaches the same lesson about itself — by the time the check
 * runs the work is finished, so the only thing a hand-back can buy is a
 * promise about the future.
 *
 * The moment that decides whether work happens in the chat is the moment
 * before the fifth tool call, not the moment after the answer. So it is a
 * guard: a conversation gets a few calls to answer a question with, and past
 * that its tools stop and it is told to start a session. Nothing is wasted —
 * the calls already made are still in its context, and they become the brief.
 *
 * BirdClaw did the blunter version and created the task in Python when routing
 * failed (`soul_loop._force_create_task`). This stops short of that on purpose:
 * a task the portal invents has no brief, and a brief the model writes from
 * what it has just learned is worth more than one assembled from a request it
 * had already decided not to follow.
 */

/**
 * Enough to answer a question, not enough to do a job.
 *
 * A real question can take a search, a read and a second search. Six web
 * searches and a chain of `bash` calls — which is what the run that prompted
 * this did — is a job.
 */
const BUDGET = Number(process.env.CHAT_TOOL_BUDGET || 4);

/**
 * Tools that do not count against it.
 *
 * Handing out and following up are the *desired* outcome and must never be
 * what pushes a conversation over the edge. The rest answer questions about
 * the agent itself, which is talking rather than working.
 */
const FREE = new Set([
  "start_task",
  "tell_task",
  "tasks_running",
  "task_list",
  "graph_recall",
  "graph_remember",
  "memory_digest",
  "identity_read",
  "self_review",
  "conversation_history",
  "search_conversations",
  "ask_primary",
  "report",
]);

const spent = new Map<string, number>();

/** A new turn starts with the whole budget. */
export function resetChatBudget(sessionId: string): void {
  spent.delete(sessionId);
}

/** Count a call and say whether this one is over. */
export function overChatBudget(sessionId: string, toolName: string): boolean {
  if (FREE.has(toolName)) return false;
  const used = (spent.get(sessionId) ?? 0) + 1;
  spent.set(sessionId, used);
  return used > BUDGET;
}

export const CHAT_BUDGET_REFUSAL = [
  "Refused: this is a conversation, and you are working.",
  "",
  `You have made ${BUDGET} tool calls answering this. Past that it is not a question being`,
  "answered, it is a job being done — and a job gets a session of its own.",
  "",
  "Call `start_task` now. You know more than you did when this started, so write the brief with",
  "what you have found: what to do, what you already know, and what counts as done. It gets a",
  "workspace and a plan, it runs while you carry on here, and its answer comes back to this",
  "conversation.",
  "",
  "If you genuinely have the answer already, say it — you do not need another tool call for that.",
].join("\n");
