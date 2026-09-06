import { EventEmitter } from "node:events";
import type { PersonRow, Role } from "./people.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PiClient } from "./pi/types.js";
import { findServerBuiltin, runBuiltin } from "./pi/builtins.js";
import { buildExecutor, executorSupports, unsupportedReason, type Executor, type ExecutorKind } from "./executors/index.js";
import { isMirrorable, mirror } from "./mirror.js";
import { harvestTurn } from "./harvest.js";
import { forgetSupervision } from "./pi/loop-supervisor.js";
import { runPlan, type StepOutcome } from "./pi/step-runner.js";
import { checkDocument } from "./pi/writing-tools.js";
import { rememberArtefact } from "./pi/prior-work.js";
import { supervise } from "./pi/supervisor.js";
import {
  addUsage,
  appendEvent,
  eventsSince,
  listTasks,
  setTaskStatus,
  type TaskRow,
  getSession,
  getSettings,
  markOrphanedSessionsInterrupted,
  routineGuards,
  routineAutonomous,
  runningQuietRoutineSessions,
  runningSessions,
  updateSession,
  type SessionRow,
} from "./db.js";

/**
 * Thinking markers that escape into the answer.
 *
 * A reasoning model sometimes closes a thought inside the text it means to say,
 * and a stray </think> then travels to whoever is reading — a chat window, a
 * Telegram message. Stripped where the text leaves the portal rather than in
 * the stored events, so the record of what the model actually produced stays
 * intact.
 */
export const stripThinkingMarkers = (text: string): string =>
  text.replace(/<\/?think(ing)?>/gi, "").trim();

/** Mirrors what the web transcript shows, so a chat and the UI agree. */
function summarizeToolInput(p: any): string | undefined {
  const input = p.input ?? p.args ?? p.parameters;
  if (!input) return undefined;
  const trim = (v: string) => (v.length > 80 ? `${v.slice(0, 79)}…` : v);
  if (typeof input === "string") return trim(input);
  if (typeof input === "object") {
    const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
    if (typeof first === "string") return trim(first);
    return trim(JSON.stringify(input));
  }
  return undefined;
}

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
const EXECUTOR_KIND = (process.env.EXECUTOR || "host") as ExecutorKind;

/**
 * Events that must not be persisted.
 *
 * Beyond noise, extension dialogs are strictly live: a stored
 * extension_ui_request would be replayed to every future reader, so reloading
 * the page reopened a dialog whose extension had long since stopped waiting.
 */
const EPHEMERAL_EVENTS = new Set([
  "queue_update",
  "extension_ui_request",
  "extension_ui_cancel",
]);

interface LiveSession {
  client: PiClient;
  executor: Executor;
}

/**
 * Owns every running pi process.
 *
 * The important property: a run is tied to this manager, not to any HTTP
 * request. Once a prompt is accepted the browser can disappear — output keeps
 * streaming into the event log, and a later reconnect replays it.
 */
class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  /** In-flight ask() per session, so messages in one chat are answered in turn. */
  private asking = new Map<string, Promise<string>>();
  /**
   * Who sent the message being handled, per session.
   *
   * Per message rather than per session because a group conversation has many
   * senders: the guard asks this at tool-call time so capability follows whoever
   * is actually speaking, not whoever spoke first.
   */
  private speaker = new Map<string, PersonRow>();
  /**
   * The session's settled role/last-known-speaker, cached at load time.
   *
   * whoNow() (passed to the pi client, and read by guard.ts on every tool
   * call) has to stay synchronous — it's a plain callback, not awaited — but
   * the DB is DuckDB now, so it can't be read fresh per call the way
   * better-sqlite3 allowed. Populated once in ensureClient() from the
   * session row, which is the "surviving a restart" fallback for a session
   * with no live in-memory speaker yet.
   */
  private settled = new Map<string, { role: Role; key?: string }>();

  constructor() {
    super();
    this.setMaxListeners(0);
    mkdirSync(SESSION_ROOT, { recursive: true });
    // Constructors can't be async; the DB is DuckDB (async) so this fires and
    // forgets, same as any other startup side effect that isn't on the
    // request path.
    void markOrphanedSessionsInterrupted().then((orphaned) => {
      if (orphaned > 0) {
        console.log(`[portal] marked ${orphaned} session(s) interrupted (server restarted mid-run)`);
      }
    });
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.client.running ?? false;
  }

  /** Record an event: persist it, then fan out to any attached SSE clients. */
  /**
   * One in-flight append per session, chained.
   *
   * pi emits streaming deltas faster than a database write completes, and
   * these calls are not awaited by their callers. Without the chain each one
   * races: `seq` comes from `nextval` *inside* the insert, so the order rows
   * are numbered is the order the inserts happen to land, and the emit below
   * runs after its own await, so live subscribers are served in completion
   * order too. The result is every token present and in the wrong order —
   * "Hello! How can I help you today?" arriving as "!Hello How help you I
   * today can?".
   *
   * It was correct before the move to DuckDB, by accident: better-sqlite3's
   * insert was synchronous, so call order was storage order and there was
   * nothing to interleave. Making the database async made ordering something
   * that has to be arranged rather than assumed.
   *
   * Per session rather than globally, because ordering only means anything
   * within one conversation and a global chain would make every session wait
   * behind every other.
   */
  private appends = new Map<string, Promise<void>>();

  private record(sessionId: string, type: string, payload: unknown): Promise<void> {
    if (EPHEMERAL_EVENTS.has(type)) {
      // Still deliver it to anyone attached right now, with a negative seq so
      // it can never be confused with a stored event during replay. Not
      // chained: it is never stored, so there is no ordering to protect.
      this.emit(`session:${sessionId}`, {
        seq: -Date.now(),
        session_id: sessionId,
        type,
        payload: JSON.stringify(payload),
      });
      return Promise.resolve();
    }

    const next = (this.appends.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const row = await appendEvent(sessionId, type, payload);
        this.emit(`session:${sessionId}`, row);
        await this.mirrorToMain(sessionId, type, payload);
      })
      // A failed append must not break the chain: the next event would then
      // never be written at all, losing the rest of the conversation rather
      // than the one row that actually failed.
      .catch((e) => {
        console.error(`[portal] failed to record ${type} for ${sessionId}:`, (e as Error).message);
      });

    this.appends.set(sessionId, next);
    return next;
  }

  /**
   * Routine slugs by session, so a mirrored line can say which routine it came
   * from. Populated at launch; a session with no entry is not a routine.
   */
  private routineOf = new Map<string, string>();

  /**
   * What to call a session in the main conversation, or nothing if it should
   * not appear there.
   *
   * Task sessions used to be excluded, so the only work visible in one place
   * was the work nobody asked for: routines mirrored, and a task you started
   * yourself did not. That is the wrong way round — a person watching the
   * agent's own conversation could see it dreaming and could not see it doing
   * the thing they had asked for.
   *
   * The main conversation itself is excluded, or it would mirror into itself.
   * Agent sessions are too: those *are* conversations with somebody, and
   * folding one person's chat into another's is not a display decision, it is
   * a disclosure.
   */
  private mirrorLabel(session: SessionRow): string | undefined {
    if (session.kind === "routine") return session.routine_slug ?? undefined;
    if (session.kind === "task") return session.title || "task";
    return undefined;
  }

  /**
   * Put a session's milestones into the agent's main conversation.
   *
   * On the same chain as the append above, so the mirror keeps the order the
   * original had. Failures are swallowed: not being able to show something is
   * not a reason to stop recording it, and the source session's own log is
   * still the authoritative record.
   */
  private async mirrorToMain(sessionId: string, type: string, payload: unknown): Promise<void> {
    const label = this.mirrorOf.get(sessionId);
    if (!label || !isMirrorable(type)) return;
    try {
      const mirrored = await mirror(EXECUTOR_KIND, { slug: label, sessionId }, type, payload);
      if (mirrored) this.emit(`session:${mirrored.sessionId}`, mirrored.row);
    } catch {
      // See above.
    }
  }

  /**
   * What each live session is called in the mirror.
   *
   * Remembered at launch rather than looked up per event: record() is on the
   * hot path for every streamed delta and must not do a database read.
   */
  private mirrorOf = new Map<string, string>();

  /**
   * Put right any session the database thinks is running that is not.
   *
   * `anySessionRunning()` gates both quiet schedules, so one row stuck at
   * `running` stops the learning loop and the Dream Cycle *permanently* —
   * every tick asks "is anything running", the answer is yes forever, and
   * nothing fires again until someone restarts the portal. That is the shape
   * of "it just stopped": no error, no log line, a system that looks healthy
   * and has quietly gone still.
   *
   * The row goes stale whenever a run ends without its closing status
   * reaching the database — a pi process that dies mid-turn, a hang the
   * timeout gives up on, a crash between the work and the update. Marking
   * orphans at boot covered exactly one of those, the restart, and left the
   * rest to be noticed by a person.
   *
   * The live client is the authority: if this process has no client for that
   * session, or it is not running, then it is not running whatever the row
   * says. Reconciled on every tick, so a stall lasts one tick rather than
   * until somebody notices.
   */
  async reconcileRunning(): Promise<number> {
    let corrected = 0;
    for (const row of await runningSessions()) {
      if (this.live.get(row.id)?.client.running) continue;
      await updateSession(row.id, { status: "idle" });
      await this.record(row.id, "portal_status", { status: "idle", reconciled: true });
      corrected++;
    }
    if (corrected) {
      console.warn(`[portal] ${corrected} session(s) were marked running but were not — released`);
    }
    return corrected;
  }

  /**
   * How far *extraction* has read. Tier 1 needs no watermark — it re-composes
   * one node per session from a bounded window, so running it again is a no-op
   * on content. Tier 2 writes facts, and reading the same span twice would
   * corroborate a passing remark into a belief purely by re-reading it.
   *
   * In memory rather than on the row: the cost of a restart is re-extracting
   * one turn, which corroborates rather than duplicates. The Dream Cycle's
   * watermark is persistent because its re-read is far more expensive.
   */
  private harvested = new Map<string, number>();

  /**
   * Fold a finished turn into the graph.
   *
   * Fire-and-forget, after the reply has already gone out: this is bookkeeping,
   * and the person waiting for an answer must never wait for it. Chained per
   * session so two fast turns cannot harvest the same span twice — which would
   * corroborate a passing remark into an established fact purely by re-reading
   * it.
   */
  private harvesting = new Map<string, Promise<void>>();

  private harvest(sessionId: string): Promise<void> {
    const next = (this.harvesting.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const session = await getSession(sessionId);
        if (!session) return;
        /**
         * Routine sessions are harvested too, and the exclusion that used to
         * be here was wrong on its facts.
         *
         * It reasoned that the learning loop "already records what it
         * concluded with graph_episode". It does not. Across sixty consecutive
         * autonomous calls in the audit log there is not one `graph_episode` —
         * there are seventeen reads of pi's own README, twenty-one of
         * SELF_CONCEPT.md, and greps for the names of its own tools. The loop
         * had no record of its previous iterations, so every one began blind
         * and reached for the nearest thing, which is always its own machinery.
         * Its instructions warn about exactly that trap — "the easiest place to
         * get stuck" — and warning was not enough, the same way it is never
         * enough.
         *
         * Recording an iteration is what lets the next one see it has been
         * here. The memory injector runs for routine sessions like any other,
         * so the loop's own recent history now comes back to it when it
         * orients, and "I have read this three times already" becomes
         * something it can notice rather than something only the audit log
         * knows.
         */
        const since = this.harvested.get(sessionId) ?? 0;
        const { harvest, seq } = await harvestTurn(session, since);
        this.harvested.set(sessionId, seq);
        if (!harvest.node) return;
        await this.record(sessionId, "portal_memory", { node: harvest.node });
        // Not awaited here: the chained promise this sits in is what the next
        // turn waits on, and extraction is a model call. It reports itself when
        // it lands, and enriches the turn after.
        void harvest.extraction.then((facts) => {
          if (facts > 0) void this.record(sessionId, "portal_memory", { node: harvest.node, facts });
        });
      })
      .catch((e) => {
        console.warn(`[portal] harvest failed for ${sessionId}:`, (e as Error).message);
      });
    this.harvesting.set(sessionId, next);
    return next;
  }

  /**
   * What pi's counters read at the end of the last turn, per session.
   *
   * Kept so each turn's cost can be worked out as a difference. pi reports
   * cumulative usage for its own conversation, which is the right thing for it
   * to report and the wrong thing to store: a routine's conversation is retired
   * when it fills up, and its counters restart while the work carries on.
   */
  private lastUsage = new Map<string, { tokensIn: number; tokensOut: number; cost: number }>();

  /**
   * Add this turn's usage to the session's running totals.
   *
   * Nothing counted tokens or cost anywhere. A portal running unattended
   * autonomous loops against a configurable model could not answer "what did
   * the learning loop cost last week", nor notice a run that had gone
   * pathological — which, over ten hours of one conversation compacting on
   * every turn, is exactly what had happened.
   *
   * Fire-and-forget after the reply has gone: this is bookkeeping, and nobody
   * should wait on it.
   */
  private async recordUsage(sessionId: string): Promise<void> {
    try {
      const stats = await this.live.get(sessionId)?.client.getStats();
      if (!stats) return;
      const now = {
        tokensIn: Number(stats.tokens?.input ?? 0),
        tokensOut: Number(stats.tokens?.output ?? 0),
        cost: Number(stats.cost ?? 0),
      };
      const before = this.lastUsage.get(sessionId);
      // A conversation that was recycled reports smaller numbers than last
      // time. Treat that as a fresh start rather than subtracting into
      // nonsense: the earlier cost is already banked on the row.
      const delta =
        before && now.tokensIn >= before.tokensIn
          ? {
              tokensIn: now.tokensIn - before.tokensIn,
              tokensOut: now.tokensOut - before.tokensOut,
              cost: Math.max(0, now.cost - before.cost),
            }
          : now;
      this.lastUsage.set(sessionId, now);
      await addUsage(sessionId, delta);
    } catch {
      // Usage is a nicety; failing to record it must not disturb the run.
    }
  }

  /** Record a portal-generated event on a session — used for run bookends. */
  /**
   * Work an outstanding plan, giving each step a context of its own.
   *
   * Runs after a turn settles, when that turn left a plan with steps in it.
   * The turn that wrote the plan is also the one carrying every false start
   * that went into writing it, so the first step is better off not inheriting
   * it either — which is why the recycle happens before each step rather than
   * between them.
   *
   * Guarded three ways, because this drives the model without anyone asking:
   * it never starts if one is already running for this session, it does
   * nothing unless there is a plan with unfinished steps, and it is skipped
   * for a session whose steps a person is working through themselves.
   */
  private working = new Set<string>();

  async workPlan(sessionId: string): Promise<StepOutcome | undefined> {
    if (process.env.STEP_ISOLATION === "off") return undefined;
    if (this.working.has(sessionId)) return undefined;

    const tasks = await listTasks(sessionId);
    if (!tasks.some((t: TaskRow) => t.status === "pending")) return undefined;
    // Only the steps this session wrote for the work in hand. A plan that
    // predates the current request would have the portal silently resume work
    // the person may have moved on from.
    const session = await getSession(sessionId);
    if (!session || session.kind === "routine") return undefined;

    this.working.add(sessionId);
    try {
      const goal = await this.lastRequest(sessionId);
      return await runPlan(goal, {
        tasks: () => listTasks(sessionId),
        document: async () => {
          const row = await getSession(sessionId);
          const file = row?.writing_file;
          return {
            file,
            written: file && existsSync(file) ? readFileSync(file, "utf8") : "",
          };
        },
        recycle: () =>
          this.recycleConversation(
            sessionId,
            "Fresh context for the next step — it gets the plan and what the earlier steps produced, " +
              "not their working.",
          ),
        ask: (message) => this.ask(sessionId, message, { internal: true }),
        supervise: () => supervise(sessionId, goal),
        note: (text) => this.record(sessionId, "portal_notice", { text }),
        // The mechanical check, run by the portal rather than left to the
        // model's own opinion of its work — see checkDocument.
        start: async (seq) => {
          await setTaskStatus(sessionId, seq, "running");
        },
        remember: async () => {
          const row = await getSession(sessionId);
          if (!row?.writing_file) return;
          const plan = await listTasks(sessionId);
          await rememberArtefact(
            row.writing_file,
            goal,
            `${plan.filter((t: TaskRow) => t.status === "done").length} section(s): ` +
              plan.map((t: TaskRow) => t.description).join(", "),
          );
        },
        verify: async () => {
          const row = await getSession(sessionId);
          return row?.writing_file ? checkDocument(row.writing_file, await listTasks(sessionId)) : [];
        },
        // "Not deep enough" turns into steps by asking the worker to extend
        // its own plan, so planning stays in one place.
        extend: async (missing) => {
          const before = (await listTasks(sessionId)).length;
          await this.ask(
            sessionId,
            [
              "Looking at what you have, this is not finished:",
              "",
              missing,
              "",
              "Add the steps that would address it to your plan with `task_plan` — keep the steps you",
              "have already done, unchanged, and put the new ones after them. Do not do the work now;",
              "each new step will come back to you on its own.",
            ].join("\n"),
          );
          return (await listTasks(sessionId)).length > before;
        },
        skipRemaining: async (why) => {
          for (const t of await listTasks(sessionId)) {
            if (t.status === "pending") await setTaskStatus(sessionId, t.seq, "failed", `not needed: ${why}`.slice(0, 300));
          }
        },
      });
    } catch (e) {
      await this.record(sessionId, "portal_notice", {
        text: `Could not work the plan: ${(e as Error).message}`,
        error: true,
      });
      return undefined;
    } finally {
      this.working.delete(sessionId);
    }
  }

  /** What the person actually asked for, which is the goal every step serves. */
  private async lastRequest(sessionId: string): Promise<string> {
    try {
      const rows = await eventsSince(sessionId, 0, 2000);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].type !== "portal_prompt") continue;
        const message = JSON.parse(rows[i].payload)?.message;
        if (typeof message === "string" && message.trim()) return message;
      }
    } catch {
      // Falling back to an empty goal is survivable — the plan is still there.
    }
    return "";
  }

  async note(sessionId: string, type: string, payload: unknown): Promise<void> {
    await this.record(sessionId, type, payload);
  }

  private async ensureClient(sessionId: string): Promise<PiClient> {
    const existing = this.live.get(sessionId);
    if (existing?.client.running) return existing.client;

    const session = await getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    this.settled.set(sessionId, { role: session.role as Role, key: session.last_person_key ?? undefined });
    // Start extraction at the end of what already exists, so a restart does not
    // re-extract the whole conversation. Tier 1 is unaffected either way.
    if (!this.harvested.has(sessionId)) {
      const seen = await eventsSince(sessionId, 0, 1_000_000);
      this.harvested.set(sessionId, seen.length ? seen[seen.length - 1].seq : 0);
    }

    /**
     * Refuse rather than run unguarded — see executorSupports.
     *
     * Thrown at launch, which is where it can still be reported: by the time a
     * channel message is being answered there is nobody left to tell, and a
     * silently unguarded session is precisely the failure this exists to
     * prevent.
     */
    if (!executorSupports(EXECUTOR_KIND, session.kind)) {
      const why = unsupportedReason(session.kind);
      await updateSession(sessionId, { status: "error", last_error: why });
      await this.record(sessionId, "portal_status", { status: "error", error: why });
      throw new Error(`This session cannot run under EXECUTOR=${EXECUTOR_KIND}: ${why}`);
    }

    const executor = buildExecutor(EXECUTOR_KIND, SESSION_ROOT);
    mkdirSync(path.join(SESSION_ROOT, sessionId), { recursive: true });

    // The session's own choices win over the portal defaults. Without this a
    // restart relaunched pi on the default model, quietly undoing the pick.
    const settings = await getSettings();
    const autonomous =
      session.kind === "routine" && (await routineAutonomous(session.routine_slug));
    // Remembered here rather than looked up per event: record() is on the hot
    // path for every streamed delta and must not do a database read.
    if (session.kind === "routine" && session.routine_slug) {
      this.routineOf.set(sessionId, session.routine_slug);
    }
    const label = this.mirrorLabel(session);
    if (label) this.mirrorOf.set(sessionId, label);
    const client = await executor.launch({
      sessionId,
      workspacePath: session.workspace,
      provider: session.provider || settings.provider,
      model: session.model || settings.model || undefined,
      thinkingLevel: session.thinking_level || settings.thinkingLevel || undefined,
      sessionFile: session.pi_session_file || undefined,
      // Channels only. A task session works inside somebody's repository and
      // has no business rescheduling anything; a routine run is excluded too,
      // since a routine that can create routines can build a chain unwatched.
      routineTools: session.kind === "agent",
      // A routine run gets the report tool instead: it is the one kind of
      // session with nobody on the other end to read what it found.
      routineSlug: session.kind === "routine" ? session.routine_slug : undefined,
      // A routine may be exempted from the taint rules; nothing else can be.
      enforceTaint: session.kind === "routine" ? await routineGuards(session.routine_slug) : true,
      // A routine that runs on the agent's own initiative. Read once at
      // launch rather than per call: unlike the speaker in a group chat, this
      // cannot change mid-session — nobody is going to start speaking for a
      // turn nobody asked for.
      autonomous,
      // Carried from the row, not restarted at false. See guard.ts.
      tainted: session.tainted === 1,
      /**
       * Trust the workspace's own `.pi` resources only where the agent owns
       * the tree.
       *
       * A task session is pointed at somebody else's repository, and a trusted
       * project there means that repo's `.pi/extensions` execute in this
       * process and its `.pi/SYSTEM.md` lands ahead of the agent's own
       * instructions. pi defaults to trusted, which is right for a developer's
       * CLI and wrong for a portal that opens sessions on whatever it is given.
       *
       * Agent and routine sessions run in agentHome() — the agent's own
       * directory — so their project resources are its own. The exception is a
       * routine with a workspace of its own (self-update, whose cwd is a source
       * tree): that tree is ours too, and it is the one place project
       * extensions are a feature rather than a hazard.
       */
      projectTrusted: session.kind !== "task",
      // The session's settled role picks the context files; the live one gates
      // each tool call, so a group conversation follows whoever is speaking.
      role: session.role,
      kind: session.kind,
      // "autonomous" is not a person's role and no row in `people` ever holds
      // it — it is the answer to "who is asking for this", when the answer is
      // nobody. It outranks the speaker because an autonomous run has no
      // speaker to defer to.
      whoNow: () =>
        autonomous
          ? { role: "autonomous" as const }
          : { role: this.speakerRole(sessionId), key: this.speakerKey(sessionId) },
    });

    // pi writes the file lazily, so it usually does not exist yet at launch.
    // Recorded the first time it appears; from then on this exact conversation
    // is what gets reopened.
    let recordedFile = session.pi_session_file;
    const rememberSessionFile = () => {
      if (recordedFile) return;
      const file = client.sessionFile;
      if (!file) return;
      recordedFile = file;
      void updateSession(sessionId, { pi_session_file: file });
    };
    rememberSessionFile();

    client.on("event", (msg) => {
      rememberSessionFile();
      void this.record(sessionId, msg.type, msg);
      // agent_end marks the end of a run — the task is done whether or not
      // anyone was watching.
      /**
       * Planning hands the work over; it does not start it.
       *
       * `write_plan`'s own result says to stop and let each section be given
       * back in a context of its own. A live run read that and carried on
       * anyway, writing all four sections in the same accumulating
       * conversation — which is the exact thing per-step isolation exists to
       * prevent, and leaves the plan as decoration.
       *
       * So the turn is ended here rather than asked to end. Nothing is wasted:
       * the plan is written, no section has been generated yet, and workPlan
       * picks it up from agent_end. This is the one place where enforcing
       * beats asking — refusing a `write` after the fact throws away a
       * generation, and ending a turn before the first section costs nothing.
       */
      if (
        msg.type === "tool_execution_end" &&
        (msg as { toolName?: string }).toolName === "write_plan" &&
        // Only when a plan was actually set. write_plan also *refuses* — when
        // sections are already written — and aborting on that turned a
        // recoverable mistake into a dead run: the step could not carry on
        // because the turn it needed had been ended under it.
        (msg as { result?: { details?: { planned?: boolean } } }).result?.details?.planned === true &&
        process.env.STEP_ISOLATION !== "off"
      ) {
        void this.record(sessionId, "portal_notice", {
          text: "Plan set. Working it one section at a time, each in its own context.",
        });
        void client.abort().catch(() => {});
      }

      /**
       * A step's turn ends when its section is written.
       *
       * The brief says "do this step and only this step" and a live run read
       * it, wrote the first section, and carried straight on through the other
       * three in the same context — so isolation happened once instead of four
       * times, and the closing turn had nothing left to assemble because one
       * conversation had seen all of it.
       *
       * Same shape as the write_plan abort, for the same reason: the turn is
       * ended after the work it was asked for is safely on disk, so nothing is
       * discarded. Only while the runner is driving — a person writing a
       * document by hand is not interrupted between sections.
       */
      if (
        msg.type === "tool_execution_end" &&
        (msg as { toolName?: string }).toolName === "write_next" &&
        typeof (msg as { result?: { details?: { wrote?: number } } }).result?.details?.wrote === "number" &&
        this.working.has(sessionId)
      ) {
        void client.abort().catch(() => {});
      }

      if (msg.type === "agent_end") {
        void updateSession(sessionId, { status: "idle" });
        void this.record(sessionId, "portal_status", { status: "idle" });
        void this.harvest(sessionId);
        void this.recordUsage(sessionId);
        // A turn that ended holding a plan with steps left is the trigger for
        // working it, one isolated context per step — see step-runner.ts.
        // Fire-and-forget, like everything else here: the run belongs to the
        // server, so a browser that disconnects mid-plan loses nothing.
        void this.workPlan(sessionId);
      }
    });

    client.on("stderr", (chunk: string) => {
      const text = chunk.trim();
      if (text) void this.record(sessionId, "stderr", { text });
    });

    client.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.live.delete(sessionId);
      void (async () => {
        const current = await getSession(sessionId);
        // A clean exit after a finished run is normal; anything else is a failure
        // worth surfacing in the UI rather than leaving as a silent stall.
        if (current?.status === "running") {
          const message = `pi exited unexpectedly (code=${code} signal=${signal})`;
          await updateSession(sessionId, { status: "error", last_error: message });
          await this.record(sessionId, "portal_status", { status: "error", error: message });
        }
        executor.cleanup?.(sessionId).catch(() => {});
      })();
    });

    this.live.set(sessionId, { client, executor });

    return client;
  }

  /**
   * Submit a prompt. Resolves once pi has accepted it — deliberately not when
   * the work finishes, so the HTTP request returns immediately and the run
   * continues in the background.
   */
  async prompt(sessionId: string, message: string, opts: { internal?: boolean } = {}): Promise<void> {
    // Real activity wakes it up: an @idle dream only exists because nothing
    // else was going on, so it yields the moment something real arrives — the
    // routine's own scheduler kicking itself off is not "real activity".
    const kind = (await getSession(sessionId))?.kind;
    if (kind && kind !== "routine") this.pauseIdleDreaming(sessionId);

    /**
     * Wait for the previous turn to be in the graph before this one starts.
     *
     * The harvest is fire-and-forget so an answer is never held up by
     * bookkeeping — but the whole point of harvesting is that the next turn can
     * search what the last one said. The memory injector runs at
     * before_agent_start, so without this the two race: reply quickly enough
     * and the context is assembled from a graph that does not yet contain the
     * exchange it should be recalling.
     *
     * Only the previous turn's write is waited on, and only its first tier —
     * which does no model call. Extraction runs on in the background and
     * arrives for the turn after, which is the right trade: the guaranteed
     * record is synchronous with the conversation, the expensive enrichment is
     * not.
     */
    await this.harvesting.get(sessionId)?.catch(() => {});

    const client = await this.ensureClient(sessionId);

    // A slash command is an instruction to the agent, not something said in the
    // conversation, so it should not appear as a chat message — its dialog or
    // output is the feedback. Matched against the real command list rather than
    // a bare leading slash, so a message that merely starts with a path like
    // "/etc/hosts is wrong" is still shown.
    const isCommand = await this.looksLikeCommand(client, message);

    // Portal builtins never reach the model — they act on the session itself.
    const builtin = /^\/([\w-]+)\s*(.*)$/.exec(message.trim());
    const serverBuiltin = builtin ? await findServerBuiltin(builtin[1]) : undefined;
    if (serverBuiltin) {
      // Not awaited: /compact is a model call and would hold the request open.
      // Same contract as a prompt — accept it, report through the event stream.
      await updateSession(sessionId, { status: "running", last_error: null });
      await this.record(sessionId, "portal_status", { status: "running" });
      void (async () => {
        try {
          const text = await runBuiltin(serverBuiltin.name, builtin![2], client);
          await this.record(sessionId, "portal_notice", { text });
        } catch (e) {
          await this.record(sessionId, "portal_notice", { text: (e as Error).message, error: true });
        } finally {
          await updateSession(sessionId, { status: "idle" });
          await this.record(sessionId, "portal_status", { status: "idle" });
        }
      })();
      return;
    }

    await updateSession(sessionId, { status: "running", last_error: null });
    /**
     * A brief the portal wrote is not something a person said.
     *
     * Recorded as `portal_prompt` it appeared in the transcript as a user
     * message — and worse, `lastRequest` finds this session's goal by reading
     * the most recent `portal_prompt`, so once a step brief was filed as one
     * the goal of the next plan would have been a brief about the last.
     */
    if (!isCommand) {
      await this.record(sessionId, opts.internal ? "portal_step" : "portal_prompt", { message });
    }
    await this.record(sessionId, "portal_status", { status: "running" });
    try {
      await client.prompt(message);
      // A slash command completes inside prompt() without starting an agent
      // turn, so no agent_end arrives to clear the status. Settle it here
      // rather than leaving "working" on screen forever.
      const idle = (client as { isIdle?: () => boolean }).isIdle?.();
      if (idle) {
        await updateSession(sessionId, { status: "idle" });
        await this.record(sessionId, "portal_status", { status: "idle" });
      }
    } catch (e) {
      const message = (e as Error).message;
      await updateSession(sessionId, { status: "error", last_error: message });
      await this.record(sessionId, "portal_status", { status: "error", error: message });
      throw e;
    }
  }

  /**
   * Prompt and wait for the answer.
   *
   * The inverse of prompt(), which returns the moment pi accepts a message —
   * the property the whole portal is built on. A channel needs the opposite:
   * somebody is sitting in a chat waiting for a reply, so this blocks until the
   * turn finishes and hands back what the agent said.
   *
   * Serialised per session. Two messages arriving in the same chat while the
   * agent is still working would otherwise interleave, and both callers would
   * see whichever agent_end came first.
   */
  ask(
    sessionId: string,
    message: string,
    opts: {
      timeoutMs?: number;
      /**
       * Relays what happens during the run — assistant prose as each stretch
       * completes, and the name of every tool as it starts.
       */
      onReply?: (text: string) => void | Promise<void>;
      /**
       * Whether prose goes through onReply as well as tool lines.
       *
       * When it does, ask() resolves with "" — it has all been handed over, and
       * returning it too would post everything twice. When it does not, only
       * tool lines are relayed and the prose comes back at the end, which is
       * what a channel showing activity but not partial answers wants.
       */
      streamText?: boolean;
      /**
       * An extension asking the user something mid-run. The browser draws a
       * modal for these; a channel has to ask in the chat and wait for the
       * next message, so it needs to know one is open.
       */
      onUi?: (request: any) => void;
      /** A prompt the portal composed — a step brief, not a person speaking. */
      internal?: boolean;
      /**
       * Most tool calls this run may make before it is stopped.
       *
       * A ceiling on work rather than on wall-clock: `timeoutMs` catches a run
       * that hangs, and catches nothing at all about a run that is busy going
       * nowhere. An unattended `@continuous` or `@idle` routine has nobody
       * watching it, so a loop that keeps finding one more thing to grep runs
       * until the hour is up and reports as a success.
       *
       * Counted from tool_execution_start, which is the honest unit here: it is
       * what the run actually does, it arrives whatever the model streams, and
       * it needs no polling.
       */
      maxToolCalls?: number;
    } = {}
  ): Promise<string> {
    const previous = this.asking.get(sessionId) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(() =>
        this.askNow(
          sessionId,
          message,
          opts.timeoutMs ?? 15 * 60_000,
          opts.onReply,
          opts.streamText,
          opts.onUi,
          opts.maxToolCalls,
          opts.internal
        )
      );
    // Kept only while it is the newest, so a finished chain is not held forever.
    this.asking.set(sessionId, next);
    void next.catch(() => {}).finally(() => {
      if (this.asking.get(sessionId) === next) this.asking.delete(sessionId);
    });
    return next;
  }

  private async askNow(
    sessionId: string,
    message: string,
    timeoutMs: number,
    onReply?: (text: string) => void | Promise<void>,
    streamText = true,
    onUi?: (request: any) => void,
    maxToolCalls?: number,
    internal = false
  ): Promise<string> {
    await this.ensureClient(sessionId);
    let toolCalls = 0;
    let exhausted = false;

    // pi emits one assistant message per stretch of talking, broken up by tool
    // calls. Each is flushed as it closes so a channel can relay progress
    // rather than sitting silent while a long task runs.
    let current = "";
    const all: string[] = [];
    let settle: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;

    // Delivery is the channel's problem; a failure there must not take down the
    // run that produced it.
    const relay = (line: string) => void Promise.resolve(onReply?.(line)).catch(() => {});

    const flush = () => {
      const done = current.trim();
      current = "";
      if (!done) return;
      all.push(done);
      if (streamText) relay(done);
    };

    const onEvent = (row: { type: string; payload: string }) => {
      let payload: any = {};
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return;
      }
      switch (row.type) {
        case "message_update": {
          const inner = payload.assistantMessageEvent ?? {};
          // Thinking deltas are not the answer, and nobody in a chat wants them.
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            current += inner.delta;
          }
          break;
        }
        case "message_end":
          flush();
          break;

        case "tool_execution_start": {
          toolCalls++;
          if (maxToolCalls && toolCalls > maxToolCalls && !exhausted) {
            // Abort rather than reject: the run has done real work and its
            // partial output is worth keeping, and abort() settles the session
            // to idle, which is what releases the quiet schedules. The reason
            // is carried out through `exhausted` so finish() can record it.
            exhausted = true;
            void this.abort(sessionId).catch(() => {});
          }
          if (!onReply) break;
          // Prose first: a tool line landing mid-sentence reads badly.
          flush();
          const name = String(payload.toolName ?? payload.name ?? "tool");
          const detail = summarizeToolInput(payload);
          relay(detail ? `⚙ ${name} · ${detail}` : `⚙ ${name}`);
          break;
        }
        // Output from a builtin like /session or /compact. It is the answer as
        // far as whoever asked is concerned, so it goes back like any other.
        case "portal_notice":
          flush();
          if (typeof payload.text === "string" && payload.text.trim()) {
            all.push(payload.text.trim());
            if (streamText) relay(payload.text.trim());
          }
          break;

        // An extension is blocking on an answer. Handed straight over: whoever
        // is asking has to put the question somewhere a human will see it.
        case "extension_ui_request":
          flush();
          onUi?.(payload);
          break;

        // The dialog gave up waiting.
        case "extension_ui_cancel":
          onUi?.({ ...payload, cancelled: true });
          break;

        case "agent_end":
          // Anything not closed by a message_end still belongs to the answer.
          flush();
          settle?.();
          break;

        case "portal_status":
          if (payload.status === "error") fail?.(new Error(String(payload.error ?? "run failed")));
          // Settled on idle, not only on agent_end. A slash command completes
          // without ever starting an agent turn, so waiting for agent_end hung
          // until the timeout — and because asks are serialised per session,
          // every later message in that chat queued behind it.
          if (payload.status === "idle") {
            flush();
            settle?.();
          }
          break;
      }
    };

    // Attached before prompting: a fast reply would otherwise finish before
    // anyone was listening.
    this.on(`session:${sessionId}`, onEvent);
    const timer = setTimeout(
      () => fail?.(new Error(`The agent did not finish within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );

    try {
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      await this.prompt(sessionId, message, { internal });
      await finished;
      if (exhausted) {
        throw new Error(
          `The run was stopped after ${maxToolCalls} tool calls — a ceiling, not a crash. ` +
            `Whatever it had done is kept; nothing was reverted.`,
        );
      }
      // Already relayed piece by piece; handing it back would post it twice.
      // Streamed already, so handing it back would post it twice.
      return onReply && streamText ? "" : all.join("\n\n").trim();
    } finally {
      clearTimeout(timer);
      this.off(`session:${sessionId}`, onEvent);
    }
  }

  /**
   * Whether a run is in flight. Checked before queueing an interrupt, which
   * would otherwise wait politely behind the very task it means to stop.
   */
  setSpeaker(sessionId: string, person: PersonRow): void {
    this.speaker.set(sessionId, person);
  }

  /**
   * The role in force right now.
   *
   * Falls back to the conversation's own role, never to "primary". Only channel
   * messages identify a speaker; a message sent through the portal's prompt
   * endpoint identifies nobody, and defaulting to primary there handed a
   * colleague's conversation full privileges — the conversation is still theirs,
   * and they still read whatever comes back.
   *
   * Synchronous by contract (the guard's whoNow() callback is sync), so this
   * cannot do a fresh DB read — DuckDB is async. Falls back to the settled
   * role cached at session launch (see ensureClient), which is itself a
   * snapshot of the session row as of the last (re)launch.
   */
  speakerRole(sessionId: string): Role {
    const live = this.speaker.get(sessionId);
    if (live) return live.role;
    return this.settled.get(sessionId)?.role ?? "guest";
  }

  /** Who is speaking, surviving a restart via the settled snapshot — see speakerRole. */
  speakerKey(sessionId: string): string | undefined {
    return this.speaker.get(sessionId)?.key ?? this.settled.get(sessionId)?.key;
  }

  currentSpeaker(sessionId: string): PersonRow | undefined {
    return this.speaker.get(sessionId);
  }

  async isBusy(sessionId: string): Promise<boolean> {
    if (this.asking.has(sessionId)) return true;
    return (await getSession(sessionId))?.status === "running";
  }

  /** Access the live client for config reads and writes, starting pi if needed. */
  client(sessionId: string): Promise<PiClient> {
    return this.ensureClient(sessionId);
  }

  /** True when the message invokes a command pi actually knows about. */
  private async looksLikeCommand(client: PiClient, message: string): Promise<boolean> {
    const match = /^\/([\w:-]+)/.exec(message.trim());
    if (!match) return false;
    try {
      const commands = await client.getCommands();
      return commands.some((c) => c.name === match[1]);
    } catch {
      return false;
    }
  }

  /** Answer an extension dialog for a live session. */
  respondUi(sessionId: string, id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    return this.live.get(sessionId)?.client.respondUi(id, response) ?? false;
  }

  async abort(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.client.running) return;
    await live.client.abort().catch(() => {});
    await updateSession(sessionId, { status: "idle" });
    await this.record(sessionId, "portal_status", { status: "idle", aborted: true });
  }

  /** Interrupt any in-progress @idle or @continuous run — see prompt(). */
  private pauseIdleDreaming(exceptSessionId: string): void {
    void (async () => {
      for (const row of await runningQuietRoutineSessions()) {
        if (row.id === exceptSessionId) continue;
        void this.abort(row.id).catch(() => {});
      }
    })();
  }

  async stop(sessionId: string): Promise<void> {
    // Let anything still queued reach the log before the client goes away,
    // then drop the chain so the map does not grow for the life of the process.
    await this.appends.get(sessionId)?.catch(() => {});
    this.appends.delete(sessionId);
    const live = this.live.get(sessionId);
    if (!live) return;
    live.client.dispose();
    this.live.delete(sessionId);
    await live.executor.cleanup?.(sessionId).catch(() => {});
  }

  /**
   * Start the conversation again, keeping the session.
   *
   * A routine that reuses its session — which is most of them, and right, since
   * "nothing new since yesterday" needs yesterday — shares one pi conversation
   * across every run it ever makes. The learning loop had been in a single one
   * for ten and a half hours: 774 iterations, 765 turns, and **1504
   * compactions**, one firing on almost every prompt.
   *
   * That is what made it read the same file over and over. It was not being
   * stubborn and it was not failing — the reads returned fine. Compaction threw
   * the tool results away to make room, so the next iteration genuinely did not
   * remember reading pi's README, and read it again. Fifteen times in a row, in
   * the audit log, while looking from the outside like a machine that had lost
   * its mind.
   *
   * The fix is the principle this codebase already runs on, applied to the loop
   * itself: assemble context rather than accumulating it. Continuity for a
   * routine belongs in the graph — where its iterations are now recorded — and
   * in `task_plan`, not in a transcript that grows forever. So the pi
   * conversation is retired when it fills up, while the portal session, its
   * event log and its history stay exactly where they are.
   *
   * Dropping `pi_session_file` is what does it: `ensureClient` reopens a stored
   * file by path and calls `create()` when there is none.
   */
  async recycleConversation(sessionId: string, reason?: string): Promise<void> {
    await this.stop(sessionId);
    // pi's counters restart with the conversation; the running totals on the
    // row do not.
    this.lastUsage.delete(sessionId);
    // The supervisor's cached opinion is about a conversation that no longer
    // exists. Carrying it into the fresh one would have the worker told it is
    // going in circles by something that watched a different run.
    forgetSupervision(sessionId);
    await updateSession(sessionId, { pi_session_file: null });
    // The reason matters. This is called for two quite different things — a
    // conversation that has actually filled up, and the deliberate recycle
    // before each isolated step — and the fixed message written for the first
    // reported the second as a problem that had not happened.
    await this.record(sessionId, "portal_notice", {
      text:
        reason ??
        "Starting a fresh conversation — the previous one had filled up. What was learned is in memory.",
    });
  }

  /**
   * How full this session's context is, 0–100, or undefined if it cannot say.
   *
   * Read from pi rather than counted here: it knows the model's real window and
   * what it has actually sent.
   */
  async contextPercent(sessionId: string): Promise<number | undefined> {
    try {
      const stats = await this.live.get(sessionId)?.client.getStats();
      const percent = stats?.contextUsage?.percent;
      return typeof percent === "number" && Number.isFinite(percent) ? percent : undefined;
    } catch {
      return undefined;
    }
  }

  /** Drop the running process so the next turn rebuilds it — used when a
   * session's role changes and its context files must be reloaded. */
  async shutdownSession(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
export { SESSION_ROOT, EXECUTOR_KIND };
