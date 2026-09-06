/**
 * Which tools a step may use, while the portal is driving one.
 *
 * BirdClaw and Sisyphean both scoped tools per stage — BirdClaw by stage type
 * (`agent/planner.py`), Sisyphean by keyword overlap down to the top four
 * (`translation/router.py`) — and the audit dropped both as compensation for a
 * model that loses focus with more than a handful of tools. That reading was
 * right about the *mechanism*: a 4B model cannot choose among twenty tools, a
 * capable one can, and a per-query list is not cache-friendly.
 *
 * What it missed is that scoping is not only about focus. A step being driven
 * by the runner is inside a plan the portal is executing, and a handful of
 * tools are not merely unhelpful there — they are actively destructive,
 * because they act on the plan that is mid-execution. Every entry below is a
 * failure watched in a live run, not a category invented for symmetry:
 *
 *   - `write_plan` / `write_project`: the step's context holds a file and a
 *     plan and no memory of writing either, so re-planning is a reasonable
 *     call from inside — and it resets the sections the run is partway
 *     through. Watched: a run reset four sections and stalled with nothing
 *     written.
 *   - `task_plan`: same, for a plan whose steps are being handed out one at a
 *     time. Rewriting it mid-flight renumbers the step the runner is waiting on.
 *   - `task_start`: the runner marks the step running itself. Watched:
 *     `task_start` marked step 1 running, `write_next` looked only at
 *     `pending`, and the area function was filed under perimeter.
 *
 * Reads, searches, memory, and every writing tool stay. This is a short
 * denylist rather than an allowlist on purpose: the constitution's allowlist
 * (constitution.ts) is the right shape for "a turn nobody asked for", where
 * the risk is unbounded action. Here the turn was asked for, by us, and the
 * risk is precisely bounded — it is the plan, and only the plan.
 */

/** Sessions the step runner is currently driving. */
const driving = new Set<string>();

export function beginDriving(sessionId: string): void {
  driving.add(sessionId);
}

export function endDriving(sessionId: string): void {
  driving.delete(sessionId);
}

export function isDriving(sessionId: string | undefined): boolean {
  return sessionId !== undefined && driving.has(sessionId);
}

/** Why this tool is refused inside a driven step, or undefined when it is fine. */
export function drivenDenial(toolName: string): string | undefined {
  switch (toolName) {
    case "write_plan":
    case "write_project":
      return (
        "You are partway through a plan — this step is one of its parts, and the portal is handing " +
        "them to you one at a time. Planning again would replace the plan being worked and lose the " +
        "parts already written. Write this part; if the plan is genuinely wrong, say so in your " +
        "answer and stop rather than re-planning underneath yourself."
      );
    case "task_plan":
      return (
        "The plan is mid-execution and its steps are being handed to you one at a time, so rewriting " +
        "it now renumbers the step you are on. Do this step; if the plan needs changing, say so and " +
        "stop."
      );
    case "task_start":
      return (
        "This step is already marked as in progress — the portal did it before giving you the step. " +
        "Calling it again moves the marker onto the *next* step, which is how a section's text ends " +
        "up recorded against the wrong one. Just do the work."
      );
    default:
      return undefined;
  }
}
