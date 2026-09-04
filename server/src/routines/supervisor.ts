import { nanoid } from "nanoid";
import { anySessionRunning, createSession, findRoutineSession, getDb, getSession, lastHumanActivity, type SessionRow } from "../db.js";
import { agentHome } from "../agent.js";
import { sessions, EXECUTOR_KIND } from "../session-manager.js";
import { isDue, nextRun, parseCron } from "./cron.js";
import { reportFraming, reportToFor } from "../pi/report-tool.js";

/**
 * Runs routines when they are due.
 *
 * A routine is a standing instruction and a schedule: when it fires the agent
 * is given the instruction, does the work, and goes quiet again. Nothing is
 * waiting on the other end the way a chat is, so a run is allowed to take as
 * long as it takes and its outcome is recorded rather than replied to.
 */

export interface RoutineRow {
  id: string;
  slug: string;
  name: string;
  enabled: number;
  schedule: string;
  /** An ISO instant, for a routine that runs once instead of repeating. */
  run_at: string | null;
  instructions: string;
  fresh_session: number;
  /** 0 turns off the injection guard's blocking rules for this routine's runs. */
  guard: number;
  /** 1 when runs are the agent's own initiative — see pi/constitution.ts. */
  autonomous: number;
  /** null runs in agentHome(), like every routine before this column existed. */
  workspace: string | null;
  /**
   * Where this routine's reports go. null inherits the portal default; the
   * empty string means it never reports, whatever the default is.
   */
  report_channel: string | null;
  report_target: string | null;
  last_report_at: string | null;
  last_run: string | null;
  last_status: string | null;
  last_output: string | null;
  last_ms: number | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}

/** How long a single run may take before it is abandoned. */
const RUN_TIMEOUT_MS = 60 * 60_000;

/** Enough of the outcome to see what happened without storing a transcript. */
const MAX_OUTPUT = 4000;

const TICK_MS = 20_000;

/**
 * `@idle` — a routine that fires when the system has gone quiet, instead of
 * on a clock. Not a cron shorthand (doesn't belong in cron.ts's SHORTHANDS —
 * it's a different trigger kind, not a cron expansion), so it's handled here.
 */
const isIdleSchedule = (schedule: string) => schedule.trim() === "@idle";

/** How long nothing must have happened before it's worth dreaming. */
const IDLE_QUIET_MS = 10 * 60_000;
/** At most this often, even if the system stays quiet the whole time. */
const IDLE_MIN_GAP_MS = 3 * 60 * 60_000;

async function isIdleDue(row: RoutineRow, now: Date): Promise<boolean> {
  // last_run is stored as new Date().toISOString() (see run(), below) — a
  // proper ISO string, independent of the DB engine's own timestamp format.
  if (row.last_run && now.getTime() - new Date(row.last_run).getTime() < IDLE_MIN_GAP_MS) {
    return false;
  }
  if (await anySessionRunning()) return false;
  const lastActivity = await lastHumanActivity();
  if (!lastActivity) return true; // nothing has ever happened — safe to dream
  return now.getTime() - lastActivity.getTime() >= IDLE_QUIET_MS;
}

class RoutineSupervisor {
  /** Routines with a run in flight — a slow one must not stack on itself. */
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private async rows(): Promise<RoutineRow[]> {
    const conn = await getDb();
    const reader = await conn.runAndReadAll("SELECT * FROM routines");
    return reader.getRowObjectsJson() as unknown as RoutineRow[];
  }

  start(): void {
    if (this.timer) return;
    void this.refreshSchedules();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recompute when each routine fires next. Cheap, and keeps the UI honest. */
  async refreshSchedules(): Promise<void> {
    const conn = await getDb();
    for (const row of await this.rows()) {
      await conn.run("UPDATE routines SET next_run = $nextRun WHERE id = $id", { nextRun: whenNext(row), id: row.id });
    }
  }

  isRunning(slug: string): boolean {
    return this.running.has(slug);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const row of await this.rows()) {
      if (!row.enabled || this.running.has(row.slug)) continue;

      if (isOneOff(row)) {
        // Deliberately catches up: a one-off whose moment passed while the
        // server was down should still happen, unlike a recurring one which
        // simply waits for its next slot.
        if (row.last_run || new Date(row.run_at!) > now) continue;
        void this.run(row, "schedule");
        continue;
      }

      if (isIdleSchedule(row.schedule)) {
        if (await isIdleDue(row, now)) void this.run(row, "schedule");
        continue;
      }

      let cron;
      try {
        cron = parseCron(row.schedule);
      } catch {
        continue;
      }
      if (!isDue(cron, now, row.last_run ? new Date(row.last_run) : null)) continue;
      void this.run(row, "schedule");
    }
  }

  /**
   * Run one routine.
   *
   * Not awaited by the tick: a routine that takes twenty minutes must not hold
   * up every other one, and the next tick skips it because it is still marked
   * as running.
   */
  async run(row: RoutineRow, trigger: "schedule" | "manual"): Promise<RoutineRow> {
    if (this.running.has(row.slug)) throw new Error(`"${row.name}" is already running`);
    this.running.add(row.slug);

    const started = Date.now();
    const conn = await getDb();
    // Written before the work, so a crash mid-run cannot make it fire again
    // the moment the server comes back.
    await conn.run(
      "UPDATE routines SET last_run = $lastRun, last_status = 'running' WHERE id = $id",
      { lastRun: new Date().toISOString(), id: row.id },
    );

    try {
      const session = await this.sessionFor(row);
      const output = await sessions.ask(session.id, await prompt(row, trigger), {
        timeoutMs: RUN_TIMEOUT_MS,
      });
      await this.finish(row.id, "ok", output, Date.now() - started);
    } catch (e) {
      await this.finish(row.id, "error", (e as Error).message, Date.now() - started);
    } finally {
      this.running.delete(row.slug);
      // A one-off has nothing left to do. Disabled rather than deleted, so the
      // result stays readable and it can be re-armed by giving it a new time.
      if (isOneOff(row)) {
        await conn.run("UPDATE routines SET enabled = 0 WHERE id = $id", { id: row.id });
      }
      await this.refreshSchedules();
    }

    const reader = await conn.runAndReadAll("SELECT * FROM routines WHERE id = $id", { id: row.id });
    return reader.getRowObjectsJson()[0] as unknown as RoutineRow;
  }

  private async finish(id: string, status: string, output: string, ms: number): Promise<void> {
    const conn = await getDb();
    await conn.run(
      "UPDATE routines SET last_status = $status, last_output = $output, last_ms = $ms WHERE id = $id",
      { status, output: (output ?? "").slice(0, MAX_OUTPUT), ms, id },
    );
  }

  /**
   * The session a run happens in.
   *
   * By default a routine keeps one, so a run can see what the last one did —
   * "nothing new since yesterday" needs yesterday. `fresh_session` gives each
   * run a clean one instead, for work where history is only noise.
   */
  private async sessionFor(row: RoutineRow): Promise<SessionRow> {
    if (!row.fresh_session) {
      const existing = await findRoutineSession(row.slug);
      if (existing) return existing;
    }

    const id = nanoid(12);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    await createSession({
      id,
      title: row.fresh_session ? `${row.name} — ${stamp}` : row.name,
      workspace: row.workspace || agentHome(),
      executor: EXECUTOR_KIND,
      kind: "routine",
      routine_slug: row.slug,
    });
    const created = await getSession(id);
    return created!;
  }
}

/**
 * What the agent is actually asked.
 *
 * The instruction is given verbatim, with a line of context around it: an agent
 * that does not know it was woken by a schedule tends to answer as if somebody
 * is waiting, and asks a follow-up question nobody will ever read.
 */
async function prompt(row: RoutineRow, trigger: "schedule" | "manual"): Promise<string> {
  const how =
    trigger === "manual"
      ? "run by hand"
      : isOneOff(row)
        ? "at the time it was scheduled for"
        : `on its schedule (${row.schedule})`;
  const reporting = reportFraming(await reportToFor(row.slug));
  return [
    `<routine name="${row.name}" trigger="${how}">`,
    "This is a scheduled task. Nobody is waiting on a reply — do the work, then",
    "finish with a short account of what you did and anything that needs a human.",
    "Do not ask questions; there is nobody to answer them.",
    ...(reporting ? ["", reporting] : []),
    "</routine>",
    "",
    row.instructions.trim(),
  ].join("\n");
}

/** A routine with a moment rather than a pattern. */
export const isOneOff = (row: { run_at: string | null; schedule: string }) =>
  Boolean(row.run_at) && !row.schedule.trim();

/** When it fires next, or null if it never will again. */
export function whenNext(row: RoutineRow): string | null {
  if (!row.enabled) return null;
  if (isOneOff(row)) return row.last_run ? null : row.run_at;
  // Fires on quiet, not a clock — there's no instant to predict.
  if (isIdleSchedule(row.schedule)) return null;
  try {
    return nextRun(parseCron(row.schedule))?.toISOString() ?? null;
  } catch {
    // An unparseable schedule is reported by the API on save; here it simply
    // never fires.
    return null;
  }
}

export const routineSupervisor = new RoutineSupervisor();
