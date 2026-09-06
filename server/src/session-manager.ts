import { EventEmitter } from "node:events";
import type { PersonRow, Role } from "./people.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PiClient } from "./pi/types.js";
import { findServerBuiltin, runBuiltin } from "./pi/builtins.js";
import { buildExecutor, type Executor, type ExecutorKind } from "./executors/index.js";
import { isMirrorable, mirror } from "./mirror.js";
import { harvestTurn } from "./harvest.js";
import {
  appendEvent,
  eventsSince,
  getSession,
  getSettings,
  markOrphanedSessionsInterrupted,
  routineGuards,
  routineAutonomous,
  runningQuietRoutineSessions,
  runningSessions,
  updateSession,
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
   * from. Populated at launch; a session with no entry is not a routine and is
   * not mirrored.
   */
  private routineOf = new Map<string, string>();

  /**
   * Put a routine's milestones into the agent's main conversation.
   *
   * On the same chain as the append above, so the mirror keeps the order the
   * original had. Failures are swallowed: not being able to show something is
   * not a reason to stop recording it, and the source session's own log is
   * still the authoritative record.
   */
  private async mirrorToMain(sessionId: string, type: string, payload: unknown): Promise<void> {
    const slug = this.routineOf.get(sessionId);
    if (!slug || !isMirrorable(type)) return;
    try {
      const mirrored = await mirror(EXECUTOR_KIND, { slug, sessionId }, type, payload);
      if (mirrored) this.emit(`session:${mirrored.sessionId}`, mirrored.row);
    } catch {
      // See above.
    }
  }

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

  /** Record a portal-generated event on a session — used for run bookends. */
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
      if (msg.type === "agent_end") {
        void updateSession(sessionId, { status: "idle" });
        void this.record(sessionId, "portal_status", { status: "idle" });
        void this.harvest(sessionId);
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
  async prompt(sessionId: string, message: string): Promise<void> {
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
    if (!isCommand) await this.record(sessionId, "portal_prompt", { message });
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
          opts.maxToolCalls
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
    maxToolCalls?: number
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
      await this.prompt(sessionId, message);
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
