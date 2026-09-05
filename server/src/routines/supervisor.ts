import { nanoid } from "nanoid";
import { anySessionRunning, createSession, findRoutineSession, getDb, getSession, lastHumanActivity, type SessionRow } from "../db.js";
import { agentHome } from "../agent.js";
import { sessions, EXECUTOR_KIND } from "../session-manager.js";
import { isDue, nextRun, parseCron } from "./cron.js";
import { reportFraming, reportToFor } from "../pi/report-tool.js";
import { PHOENIXCLAW_ROOT, PI_SOURCE_DIR } from "../db.js";
import { afterRun, beforeRun, summarise, treesFor, type Snapshot } from "./self-update-envelope.js";

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

/**
 * Most tool calls a run nobody asked for may make.
 *
 * The timeout above bounds a run that hangs. It bounds nothing about a run that
 * is busy: the learning loop is instructed to do one step and stop, and a model
 * that keeps finding one more thing to check instead will spend the hour doing
 * it and report success. BirdClaw force-advanced its loop on budget exhaustion
 * for the same reason (`agent/budget.py`).
 *
 * Generous on purpose — the Dream Cycle's eight phases each call several tools,
 * and a ceiling that fires in normal operation would be worse than none,
 * because the first thing anyone would do is raise it and stop reading it.
 * Applied only to `autonomous` routines: a run somebody asked for has somebody
 * waiting, and they can stop it themselves.
 */
const AUTONOMOUS_TOOL_CEILING = Number(process.env.AUTONOMOUS_TOOL_CEILING || 120);

/** Enough of the outcome to see what happened without storing a transcript. */
const MAX_OUTPUT = 4000;

const TICK_MS = 20_000;

/**
 * Two schedules that fire on quiet rather than on a clock. Neither is a cron
 * shorthand — they're a different trigger kind, not a cron expansion, so they
 * don't belong in cron.ts's SHORTHANDS and are handled here.
 *
 * `@idle` is occasional and deep: ten minutes of quiet, then at most once
 * every three hours. The Dream Cycle is the one that ships on it.
 *
 * `@continuous` is the loop — a minute of quiet and no minimum gap, so an
 * iteration follows the last one for as long as nothing else is going on. It
 * is the agent's default activity rather than an event, which is why it
 * yields to everything: see the tick, where it is considered last and only
 * when nothing else wanted to run.
 */
export const isIdleSchedule = (schedule: string) => schedule.trim() === "@idle";
export const isContinuousSchedule = (schedule: string) => schedule.trim() === "@continuous";
export const isQuietSchedule = (schedule: string) =>
  isIdleSchedule(schedule) || isContinuousSchedule(schedule);

/** How long nothing must have happened before it's worth dreaming. */
const IDLE_QUIET_MS = 10 * 60_000;
/** At most this often, even if the system stays quiet the whole time. */
const IDLE_MIN_GAP_MS = 3 * 60 * 60_000;

/**
 * Long enough that the loop does not start a thought in the gap between two
 * of your messages, short enough that it is genuinely running rather than
 * waiting. There is no minimum gap to go with it: back-to-back is the point.
 */
const CONTINUOUS_QUIET_MS = 60_000;

/** Shared by both: something is already running, or a human just did something. */
async function quietFor(quietMs: number, now: Date): Promise<boolean> {
  if (await anySessionRunning()) return false;
  const lastActivity = await lastHumanActivity();
  // lastHumanActivity() excludes routine sessions, so the loop's own runs do
  // not keep resetting this and starve the @idle routines of their quiet.
  if (!lastActivity) return true;
  return now.getTime() - lastActivity.getTime() >= quietMs;
}

async function isIdleDue(row: RoutineRow, now: Date): Promise<boolean> {
  // last_run is stored as new Date().toISOString() (see run(), below) — a
  // proper ISO string, independent of the DB engine's own timestamp format.
  if (row.last_run && now.getTime() - new Date(row.last_run).getTime() < IDLE_MIN_GAP_MS) {
    return false;
  }
  return quietFor(IDLE_QUIET_MS, now);
}

const isContinuousDue = (now: Date): Promise<boolean> => quietFor(CONTINUOUS_QUIET_MS, now);

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

    // Before deciding whether anything is due: a session wrongly marked
    // running blocks every quiet schedule forever. See reconcileRunning.
    await sessions.reconcileRunning().catch(() => {});

    /**
     * `@continuous` is collected here and considered last, only if nothing
     * else wanted this tick. It is what the agent does when there is nothing
     * else to do, so everything else takes precedence by definition.
     *
     * Without that ordering the loop would starve every `@idle` routine
     * outright: the Dream Cycle needs ten minutes with no session running,
     * and a loop that fires whenever the system is quiet means that stretch
     * never arrives.
     */
    const continuous: RoutineRow[] = [];
    let startedSomething = false;

    for (const row of await this.rows()) {
      if (!row.enabled || this.running.has(row.slug)) continue;

      if (isContinuousSchedule(row.schedule)) {
        continuous.push(row);
        continue;
      }

      if (isOneOff(row)) {
        // Deliberately catches up: a one-off whose moment passed while the
        // server was down should still happen, unlike a recurring one which
        // simply waits for its next slot.
        if (row.last_run || new Date(row.run_at!) > now) continue;
        startedSomething = true;
        void this.run(row, "schedule");
        continue;
      }

      if (isIdleSchedule(row.schedule)) {
        if (await isIdleDue(row, now)) {
          startedSomething = true;
          void this.run(row, "schedule");
        }
        continue;
      }

      let cron;
      try {
        cron = parseCron(row.schedule);
      } catch {
        continue;
      }
      if (!isDue(cron, now, row.last_run ? new Date(row.last_run) : null)) continue;
      startedSomething = true;
      void this.run(row, "schedule");
    }

    if (startedSomething || this.running.size > 0) return;
    for (const row of continuous) {
      if (!(await isContinuousDue(now))) return;
      void this.run(row, "schedule");
      // One iteration per tick, and one loop at a time however many are
      // enabled: two of these racing would each see the other's session
      // running and spend the day taking turns doing nothing.
      return;
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

    /**
     * Self-update edits the source of the portal it is running inside, so its
     * safety cannot be instructions alone — see self-update-envelope.ts. The
     * envelope refuses a dirty tree, verifies what changed, and reverts what
     * does not build, whatever the model did or did not do.
     *
     * Matched on slug because these are the only routines that legitimately
     * write to those trees. The pair this replaced is still recognised, so a
     * deployment that enabled one keeps the envelope rather than silently
     * losing it at upgrade — the same rule sdk-client.ts follows for the
     * constitution.
     */
    const enveloped = ["self-update", "self-update-phoenixclaw", "self-update-pi"].includes(row.slug);
    const trees = enveloped ? treesFor(PHOENIXCLAW_ROOT, PI_SOURCE_DIR) : [];
    let snapshots: Snapshot[] = [];
    if (enveloped) {
      const pre = await beforeRun(trees);
      if (!pre.ok) {
        await this.finish(row.id, "error", pre.reason, Date.now() - started);
        this.running.delete(row.slug);
        await this.refreshSchedules();
        const reader = await conn.runAndReadAll("SELECT * FROM routines WHERE id = $id", { id: row.id });
        return reader.getRowObjectsJson()[0] as unknown as RoutineRow;
      }
      snapshots = pre.snapshots;
    }

    try {
      const session = await this.sessionFor(row);
      // Bookends, so the mirrored stream in the main conversation reads as
      // "it started this, then it did these things, then it finished" rather
      // than as loose output appearing from nowhere.
      await sessions.note(session.id, "portal_routine", { routine: row.name, slug: row.slug, phase: "start" });
      const output = await sessions.ask(session.id, await prompt(row, trigger), {
        timeoutMs: RUN_TIMEOUT_MS,
        ...(row.autonomous ? { maxToolCalls: AUTONOMOUS_TOOL_CEILING } : {}),
      });
      await sessions.note(session.id, "portal_routine", {
        routine: row.name,
        slug: row.slug,
        phase: "end",
        summary: (output ?? "").slice(0, 400),
      });
      // Verified before the run is called ok: a change that does not build is
      // reverted, and the outcome joins the stored output so the report says
      // what actually happened to the tree rather than what the model believed.
      let verdict = "";
      if (enveloped) {
        const outcomes = await afterRun(trees, snapshots);
        verdict = summarise(outcomes);
        const broke = outcomes.some((o) => o.reverted);
        await sessions.note(session.id, "portal_routine", {
          routine: row.name,
          slug: row.slug,
          phase: "verify",
          summary: verdict,
        });
        await this.finish(row.id, broke ? "error" : "ok", `${output ?? ""}\n\n${verdict}`.trim(), Date.now() - started);
      } else {
        await this.finish(row.id, "ok", output, Date.now() - started);
      }
    } catch (e) {
      // A run that failed part-way is the case the revert exists for: it is
      // most likely to have left a half-finished edit behind.
      let verdict = "";
      if (enveloped && snapshots.length) {
        verdict = summarise(await afterRun(trees, snapshots)).trim();
      }
      const message = (e as Error).message;
      await this.finish(row.id, "error", verdict ? `${message}\n\n${verdict}` : message, Date.now() - started);
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
