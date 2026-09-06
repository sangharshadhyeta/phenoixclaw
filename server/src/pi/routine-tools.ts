import { Type } from "typebox";
import { nanoid } from "nanoid";
import { pruneOldRecords, trimEventLog } from "../db.js";
import { clusterIsolatedNodes, decayStaleBeliefs, pruneByAge, pruneExpired, refineRelations } from "../graph.js";
import { getDb, type SessionRow } from "../db.js";
import { unscopeKey } from "../agent.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { isValidSlug, slugify } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "../routines/cron.js";
import {
  routineSupervisor,
  whenNext,
  type RoutineRow,
} from "../routines/supervisor.js";

/**
 * Routine management, as tools the agent can call.
 *
 * Registered inline rather than shipped as a package: the portal already owns
 * routines, and a package would have to call back over HTTP with a credential
 * to reach the database it is sitting next to.
 *
 * This is what makes "remind me every morning to check the backups" work from a
 * chat — the agent writes the routine itself instead of telling you where the
 * button is.
 *
 * Only registered for sessions reached through a channel. A task session
 * working in some repository has no business touching the schedule, and a
 * routine run does not get them either: a routine able to create routines can
 * form a chain with nobody watching it.
 *
 * There is no delete. Disabling stops a routine firing and leaves it visible,
 * so a misheard "cancel the morning thing" is recoverable; deleting outright
 * stays a deliberate act in the UI.
 */

// AgentTool.execute() returns { content, details } — pi has no isError field
// on a successful return; a failure is signalled by throwing instead (pi
// converts the thrown message into the same content shape with isError set).
const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const bad = (text: string): never => {
  throw new Error(text);
};

async function rows(): Promise<RoutineRow[]> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT * FROM routines ORDER BY created_at ASC");
  return reader.getRowObjectsJson() as unknown as RoutineRow[];
}

async function byName(needle: string): Promise<RoutineRow | undefined> {
  const key = needle.trim().toLowerCase();
  const all = await rows();
  return (
    all.find((r) => r.slug === key) ??
    all.find((r) => r.name.toLowerCase() === key) ??
    all.find((r) => r.id === needle.trim())
  );
}

const describe = (r: RoutineRow) => ({
  name: r.name,
  slug: r.slug,
  enabled: Boolean(r.enabled),
  when: r.run_at ? `once at ${r.run_at}` : r.schedule,
  nextRun: whenNext(r),
  lastRun: r.last_run,
  lastStatus: r.last_status,
  instructions: r.instructions,
});

/** Same rule as the HTTP API: a schedule or a moment, never both. */
function timing(schedule?: string, runAt?: string) {
  const cron = (schedule ?? "").trim();
  const at = (runAt ?? "").trim();
  if (cron && at)
    return { error: "Give a schedule or a one-off time, not both" };
  if (!cron && !at)
    return { error: "Needs either a cron schedule or a time to run once" };
  if (cron) {
    // "@idle" fires when the system has gone quiet rather than on a cron
    // schedule (see routines/supervisor.ts) — not a real cron expression.
    if (cron === "@idle") return { schedule: cron, runAt: null as string | null };
    const problem = isValidCron(cron);
    return problem
      ? { error: problem }
      : { schedule: cron, runAt: null as string | null };
  }
  const when = new Date(at);
  if (Number.isNaN(when.getTime()))
    return { error: `"${at}" is not a time I can read` };
  return { schedule: "", runAt: when.toISOString() };
}

async function freeSlug(desired: string, exceptId?: string): Promise<string> {
  const base = slugify(desired) || "routine";
  const taken = new Set(
    (await rows())
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++)
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`No free slug for "${desired}"`);
}

/**
 * Where a routine created from a conversation should report.
 *
 * Back into the conversation that asked for it. Someone setting up a morning
 * summary from a Telegram chat means "tell me here" — anything else makes them
 * configure a destination for a thing they just described in one sentence.
 *
 * The portal default remains the fallback, for a routine created any other way
 * — and for a conversation whose channel cannot speak first. A browser chat is
 * an agent session like any other, but "reply in the portal" is not somewhere a
 * report can be delivered, and pointing a routine there would be worse than
 * leaving it on the default.
 */
export async function reportBackTo(sessionId?: string): Promise<{
  channel: string | null;
  target: string | null;
}> {
  if (!sessionId) return { channel: null, target: null };
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT * FROM sessions WHERE id = $id", { id: sessionId });
  const session = reader.getRowObjectsJson()[0] as unknown as SessionRow | undefined;
  if (!session?.channel_slug || !session.channel_key)
    return { channel: null, target: null };
  if (!channelSupervisor.canSend(session.channel_slug))
    return { channel: null, target: null };
  return {
    channel: session.channel_slug,
    target: unscopeKey(session.channel_slug, session.channel_key),
  };
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function routineTools(sessionId?: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "routines_list",
      label: "List routines",
      description:
        "List the scheduled routines: what each does, when it next runs, and how the last run went.",
      promptSnippet:
        "routines_list — see the scheduled work that already exists",
      parameters: Type.Object({}),
      async execute() {
        const all = await rows();
        if (!all.length) return ok("No routines are set up.");
        return ok(JSON.stringify(all.map(describe), null, 2));
      },
    });

    pi.registerTool({
      name: "routine_create",
      label: "Create routine",
      description:
        "Schedule work to happen later, either repeatedly on a cron schedule or once at a given time. " +
        "The instructions are what you will be asked to do when it fires, so write them as a standing " +
        "instruction to yourself — nobody is there to answer a question.",
      promptSnippet:
        "routine_create — schedule work for later, once or repeatedly",
      parameters: Type.Object({
        name: Type.String({
          description: "Short human name, e.g. 'Morning summary'",
        }),
        instructions: Type.String({ description: "What to do when it fires" }),
        schedule: Type.Optional(
          Type.String({
            description:
              "Five-field cron or an @shorthand, e.g. '0 9 * * 1-5' or '@daily'",
          }),
        ),
        runAt: Type.Optional(
          Type.String({
            description:
              "ISO 8601 instant for a one-off, e.g. '2026-08-01T09:00:00Z'",
          }),
        ),
        freshSession: Type.Optional(
          Type.Boolean({
            description:
              "Start each run with no memory of the last one. Defaults to false.",
          }),
        ),
      }),
      async execute(_id: string, p: any) {
        if (!p.name?.trim()) return bad("A routine needs a name");
        const t = timing(p.schedule, p.runAt);
        if ("error" in t) return bad(t.error!);

        const id = nanoid(10);
        const slug = await freeSlug(p.name);
        const back = await reportBackTo(sessionId);
        const conn = await getDb();
        await conn.run(
          `INSERT INTO routines
           (id, slug, name, schedule, run_at, instructions, fresh_session, next_run,
            report_channel, report_target)
         VALUES ($id, $slug, $name, $schedule, $runAt, $instructions, $freshSession, $nextRun, $reportChannel, $reportTarget)`,
          {
            id,
            slug,
            name: p.name.trim(),
            schedule: t.schedule,
            runAt: t.runAt,
            instructions: (p.instructions ?? "").trim(),
            freshSession: p.freshSession ? 1 : 0,
            nextRun: t.schedule ? (nextRun(parseCron(t.schedule))?.toISOString() ?? null) : t.runAt,
            reportChannel: back.channel,
            reportTarget: back.target,
          },
        );
        await routineSupervisor.refreshSchedules();

        const created = (await byName(slug))!;
        return ok(
          `Created "${created.name}". Next run: ${whenNext(created) ?? "not scheduled"}.` +
            (back.channel
              ? " It will report back into this conversation."
              : ""),
        );
      },
    });

    pi.registerTool({
      name: "routine_update",
      label: "Update routine",
      description:
        "Change an existing routine: its schedule, its instructions, its name, or whether it is enabled. " +
        "Only the fields you pass are changed.",
      parameters: Type.Object({
        routine: Type.String({
          description: "Name or slug of the routine to change",
        }),
        name: Type.Optional(Type.String()),
        instructions: Type.Optional(Type.String()),
        schedule: Type.Optional(
          Type.String({ description: "Cron. Clears any one-off time." }),
        ),
        runAt: Type.Optional(
          Type.String({
            description: "ISO instant. Clears any cron schedule.",
          }),
        ),
        enabled: Type.Optional(
          Type.Boolean({
            description:
              "False stops it running while keeping it. This is how you cancel one.",
          }),
        ),
      }),
      async execute(_id: string, p: any) {
        const row = await byName(p.routine ?? "");
        if (!row) return bad(`No routine called "${p.routine}"`);

        const sets: string[] = [];
        const params: Record<string, any> = { id: row.id };

        if (typeof p.name === "string" && p.name.trim()) {
          sets.push("name = $name");
          params.name = p.name.trim();
        }
        if (typeof p.instructions === "string") {
          sets.push("instructions = $instructions");
          params.instructions = p.instructions.trim();
        }
        if (typeof p.enabled === "boolean") {
          sets.push("enabled = $enabled");
          params.enabled = p.enabled ? 1 : 0;
        }
        if (p.schedule !== undefined || p.runAt !== undefined) {
          const t = timing(p.schedule, p.runAt);
          if ("error" in t) return bad(t.error!);
          sets.push("schedule = $schedule", "run_at = $runAt");
          params.schedule = t.schedule;
          params.runAt = t.runAt;
          // A one-off given a new time is armed again rather than looking done.
          if (t.runAt && t.runAt !== row.run_at) {
            sets.push("last_run = NULL", "last_status = NULL", "last_output = NULL");
          }
        }
        if (!sets.length)
          return bad("Nothing to change — pass at least one field");

        sets.push("updated_at = now()");
        const conn = await getDb();
        await conn.run(`UPDATE routines SET ${sets.join(", ")} WHERE id = $id`, params);
        await routineSupervisor.refreshSchedules();

        const after = (await byName(row.slug))!;
        return ok(
          `Updated "${after.name}". Next run: ${whenNext(after) ?? "not scheduled"}`,
        );
      },
    });

    pi.registerTool({
      name: "routine_run",
      label: "Run routine now",
      description:
        "Run a routine immediately without waiting for its schedule. Useful for checking that a routine " +
        "you just created does what was intended.",
      parameters: Type.Object({
        routine: Type.String({
          description: "Name or slug of the routine to run",
        }),
      }),
      async execute(_id: string, p: any) {
        const row = await byName(p.routine ?? "");
        if (!row) return bad(`No routine called "${p.routine}"`);
        try {
          const after = await routineSupervisor.run(row, "manual");
          const output = (after.last_output ?? "").trim();
          return after.last_status === "ok"
            ? ok(output || "Ran, with no output.")
            : bad(`It failed: ${output}`);
        } catch (e) {
          return bad((e as Error).message);
        }
      },
    });
  };
}

/**
 * The two tools a routine run needs to look after itself, split out from the
 * scheduling ones above.
 *
 * They were registered together, and `routineTools` is only ever given to
 * channel sessions — so a routine session had neither. The Dream Cycle's
 * instructions have been telling it to advance its own phase and prune old
 * records the whole time, using tools it was never handed: the resume
 * mechanism documented in docs/guide/routines.md could not have worked, and
 * the cleanup phase failed every run.
 *
 * Kept apart rather than fixed by giving routines the whole set, because the
 * reason routines were excluded is still true for the other half: a routine
 * that can create routines can build a chain with nobody watching it. These
 * two only reach the routine's own instructions and the portal's own stale
 * records.
 */
export function selfMaintenanceTools() {
  return (pi: any): void => {
    pi.registerTool({
      name: "dream_progress",
      label: "Advance Dream Cycle",
      description:
        "Update the self-reflection routine to the next phase of the Dream Cycle. " +
        "This ensures that if the cycle is interrupted, it resumes from the correct phase.",
      parameters: Type.Object({
        phase: Type.String({
          description: "The name of the phase to advance to (e.g., 'PHASE 2: GRAPH ENRICHMENT'). This must match a phase header in the current instructions.",
        }),
      }),
      async execute(_id: string, p: any) {
        const slug = "self-reflection";
        const row = await byName(slug);
        if (!row) return bad(`No routine called "${slug}"`);

        /**
         * The phase is recorded; the instructions are never touched.
         *
         * This used to slice the instructions at the phase header and save the
         * remainder, so every advance permanently destroyed the phases before
         * it. By phase 8 the routine was the single line "You are continuing a
         * Dream Cycle. The next phase is: PHASE 8: REPORT" — it could never
         * return to phase 1, and the cycle was over for good. A routine must
         * not be able to eat its own instructions.
         */
        if (!row.instructions.includes(p.phase)) {
          return bad(
            `Phase "${p.phase}" is not one of this routine's phases. Use an exact header from the instructions.`,
          );
        }

        const conn = await getDb();
        await conn.run("UPDATE routines SET phase = $phase, updated_at = now() WHERE id = $id", {
          phase: p.phase,
          id: row.id,
        });

        await routineSupervisor.refreshSchedules();

        return ok(`Dream Cycle advanced to "${p.phase}".`);
      },
    });

    pi.registerTool({
      name: "routine_cleanup",
      label: "Cleanup",
      description:
        "Prune stale sessions, old tasks, and expired or aged-out memory (cached tool results, page " +
        "captures, old episodes and workspace notes), and let beliefs nobody has re-observed lose " +
        "confidence so mistakes fade instead of hardening. anchor/user/project nodes are never " +
        "touched, regardless of age. Neither are routines, pinned sessions, or the session a routine " +
        "works in — none of those go stale, and none are yours to remove.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "How many days of history to keep. Defaults to 30." })),
      }),
      async execute(_id: string, p: any) {
        const days = typeof p.days === "number" ? p.days : 30;
        const { sessions } = await pruneOldRecords(days);
        // The event log is the part that actually grew unbounded — see
        // trimEventLog for the 2.2 GB database it produced.
        const events = await trimEventLog();
        /**
         * Beliefs nobody has re-observed lose standing.
         *
         * This is the half that makes the graph self-correcting rather than
         * something a person has to keep weeding. A wrong belief used to be
         * permanent — confidence only ever rose — so every mistake had to be
         * found and deleted by hand, which does not scale past the first few.
         * Decay means an unrepeated claim fades on its own while a real one,
         * re-observed even occasionally, stays where it is.
         */
        const decayed = await decayStaleBeliefs(days);
        /**
         * Two passes that make the graph navigable rather than merely full.
         *
         * Decay is about what is *true*; these are about what is *reachable*.
         * Extraction writes a node per fact, so a run of searches on one
         * subject leaves a handful connected to nothing — findable by name and
         * unreachable from anything else the agent knows. And it writes
         * `related_to` whenever it sees two things together and cannot say how,
         * which records that both exist and nothing more.
         *
         * Both belong here rather than anywhere nearer the moment: they need
         * several nodes to have accumulated before there is a pattern to see,
         * and a wrong grouping in an unattended pass costs an edge that recall
         * may follow, not a claim the agent will assert.
         */
        const { clusters, linked } = await clusterIsolatedNodes();
        const refined = await refineRelations();

        const expired = await pruneExpired();
        const aged = (
          await Promise.all(
            (["episode", "tool_cache", "page", "workspace_note"] as const).map((type) => pruneByAge(type, days)),
          )
        ).reduce((a, b) => a + b, 0);
        return ok(
          `Cleanup complete. Pruned ${sessions} sessions, ${expired} expired and ${aged} ` +
            `aged-out memory nodes, trimmed ${events} old event(s) from the log, and let ` +
            `${decayed} unrepeated belief(s) lose confidence. Linked ${linked} unconnected ` +
            `node(s) under ${clusters} topic(s), and gave ${refined} vague edge(s) a real name.`,
        );
      },
    });
  };
}
