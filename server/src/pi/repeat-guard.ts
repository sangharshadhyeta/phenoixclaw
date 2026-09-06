/**
 * The same call, over and over, stopped rather than noticed.
 *
 * `repetition()` in supervisor.ts sees this and says so — and saying so is not
 * enough. A learning-loop iteration made 106 tool calls in one turn, of which
 * about a hundred were `task_start` with no arguments, because the tool
 * answers "nothing pending" without being an error and the model read that as
 * something to try again.
 *
 * The supervisor's nudge cannot help here for two reasons: it runs in the
 * background and lands on a *later* request, and by then the turn has spent
 * itself. A loop is one of the few things that is unambiguous from the outside
 * — the same tool, the same arguments, the same answer — so it does not need
 * judgement, it needs a stop.
 *
 * Per turn rather than per session: calling `read` on the same file in two
 * different turns is ordinary, and calling it eight times in one is not.
 */

/** Enough for a legitimate retry, not enough to be a loop. */
const LIMIT = Number(process.env.REPEAT_CALL_LIMIT || 3);

const seen = new Map<string, Map<string, number>>();

export function resetRepeats(sessionId?: string): void {
  // No argument clears everything — a fresh start, which is what a contract
  // wants between groups of assertions and what a restart amounts to.
  if (sessionId === undefined) seen.clear();
  else seen.delete(sessionId);
}

/** Count this call and say whether it has now been made too many times. */
export function tooManyRepeats(sessionId: string, toolName: string, args: unknown): boolean {
  let key: string;
  try {
    key = `${toolName}:${JSON.stringify(args ?? {})}`;
  } catch {
    key = toolName;
  }
  const forSession = seen.get(sessionId) ?? new Map<string, number>();
  seen.set(sessionId, forSession);
  const n = (forSession.get(key) ?? 0) + 1;
  forSession.set(key, n);
  return n > LIMIT;
}

export function repeatRefusal(toolName: string): string {
  return [
    `Refused: you have called \`${toolName}\` with the same arguments ${LIMIT} times in this turn`,
    "and had the same answer every time. It will not be different on the next one.",
    "",
    "Whatever you are waiting for is not going to arrive by asking again. Either do something else",
    "with what you already have, or say plainly what is blocking you and stop — an account of a",
    "wall is a real answer, and a hundred identical calls is not.",
  ].join("\n");
}
