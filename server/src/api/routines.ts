import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { getDb, getDefaultReportTo, listRoutineSessions, setDefaultReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { isValidSlug, slugify } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "../routines/cron.js";
import { isOneOff, routineSupervisor, whenNext, type RoutineRow } from "../routines/supervisor.js";

/**
 * Scheduled work: a standing instruction, a cron expression, and a record of
 * how the last run went.
 */

const toApi = (row: RoutineRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  enabled: Boolean(row.enabled),
  schedule: row.schedule,
  runAt: row.run_at,
  /** "once" or "repeats" — the two are mutually exclusive. */
  mode: isOneOff(row) ? ("once" as const) : ("repeats" as const),
  /** A one-off that has already run. Kept so its result stays readable. */
  done: isOneOff(row) && Boolean(row.last_run),
  instructions: row.instructions,
  freshSession: Boolean(row.fresh_session),
  guard: row.guard === 1,
  /** Runs on the agent's own initiative, held to the constitution's allowlist. */
  autonomous: row.autonomous === 1,
  /** null inherits the portal default; "" is an explicit "never report". */
  reportChannel: row.report_channel,
  reportTarget: row.report_target,
  lastReportAt: row.last_report_at,
  lastRun: row.last_run,
  lastStatus: routineSupervisor.isRunning(row.slug) ? "running" : row.last_status,
  lastOutput: row.last_output,
  lastMs: row.last_ms,
  nextRun: row.next_run,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * A routine either repeats on a schedule or happens once at a moment. Both or
 * neither is not a thing, and saying so beats guessing which was meant.
 */
function readTiming(input: { schedule?: unknown; runAt?: unknown }):
  | { schedule: string; runAt: string | null }
  | { error: string } {
  const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
  const runAt = typeof input.runAt === "string" ? input.runAt.trim() : "";

  if (schedule && runAt) return { error: "Give a schedule or a time to run once, not both" };
  if (!schedule && !runAt) return { error: "Needs a schedule, or a time to run once" };

  if (schedule) {
    // Neither of these is a cron shorthand — they're a different trigger
    // kind (fire when the system has gone quiet, see routines/supervisor.ts),
    // so they skip cron validation rather than joining cron.ts's SHORTHANDS.
    if (schedule === "@idle" || schedule === "@continuous") return { schedule, runAt: null };
    const bad = isValidCron(schedule);
    return bad ? { error: bad } : { schedule, runAt: null };
  }

  const at = new Date(runAt);
  if (Number.isNaN(at.getTime())) return { error: `"${runAt}" is not a time I can read` };
  return { schedule: "", runAt: at.toISOString() };
}

/**
 * A destination, as three states rather than two.
 *
 * Absent or null inherits the portal default; the empty string is an explicit
 * "this one stays quiet" that a later change to the default must not override.
 */
function readReport(body: any): { channel: string | null; target: string | null } {
  const channel = body?.reportChannel;
  if (channel === "") return { channel: "", target: "" };
  if (typeof channel === "string" && channel && typeof body?.reportTarget === "string") {
    return { channel, target: body.reportTarget };
  }
  return { channel: null, target: null };
}

/** Slugs own the sessions, so two routines must never share one. */
async function freeSlug(desired: string, exceptId?: string): Promise<string> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT id, slug FROM routines");
  const rows = reader.getRowObjectsJson() as unknown as { id: string; slug: string }[];
  const base = slugify(desired) || "routine";
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`Could not find a free slug for "${desired}"`);
}

/**
 * Somewhere a report could be sent.
 *
 * Built from conversations that already exist rather than asked for as a chat
 * id: you pick "Telegram — Anirban Kar", and a channel that can only answer
 * (a webhook) never appears, because it cannot speak first.
 */
async function reportTargets() {
  const conn = await getDb();
  const reader = await conn.runAndReadAll(
    `SELECT channel_slug, channel_key, title FROM sessions
     WHERE kind = 'agent' AND channel_slug IS NOT NULL AND channel_key IS NOT NULL
     ORDER BY updated_at DESC`,
  );
  const rows = reader.getRowObjectsJson() as unknown as { channel_slug: string; channel_key: string; title: string }[];

  const seen = new Set<string>();
  const out: { channel: string; target: string; label: string }[] = [];
  for (const r of rows) {
    if (!channelSupervisor.canSend(r.channel_slug)) continue;
    // The key is stored scoped by channel; the package expects its own key back.
    const target = r.channel_key.startsWith(`${r.channel_slug}:`)
      ? r.channel_key.slice(r.channel_slug.length + 1)
      : r.channel_key;
    const id = `${r.channel_slug} ${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ channel: r.channel_slug, target, label: r.title });
  }
  return out;
}

export function routinesRouter(): Router {
  const router = express.Router();

  /** Destinations a routine can report to, and the portal-wide default. */
  router.get("/routines/report-targets", async (_req, res) => {
    res.json({ targets: await reportTargets(), default: await getDefaultReportTo() });
  });

  router.put("/routines/report-default", async (req, res) => {
    const { channel, target } = req.body ?? {};
    if (!channel || !target) {
      await setDefaultReportTo(null);
      return res.json({ default: null });
    }
    if (typeof channel !== "string" || typeof target !== "string") {
      return res.status(400).json({ error: "channel and target must be strings" });
    }
    await setDefaultReportTo({ channel, target });
    res.json({ default: await getDefaultReportTo() });
  });

  const rowById = async (id: string): Promise<RoutineRow | undefined> => {
    const conn = await getDb();
    const reader = await conn.runAndReadAll("SELECT * FROM routines WHERE id = $id", { id });
    return reader.getRowObjectsJson()[0] as unknown as RoutineRow | undefined;
  };

  router.get("/routines", async (_req, res) => {
    const conn = await getDb();
    const reader = await conn.runAndReadAll("SELECT * FROM routines ORDER BY created_at ASC");
    const rows = reader.getRowObjectsJson() as unknown as RoutineRow[];
    res.json({ routines: rows.map(toApi) });
  });

  router.post("/routines", async (req, res) => {
    const { name, schedule, runAt, instructions, freshSession } = req.body ?? {};
    const report = readReport(req.body);
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }

    const timing = readTiming({ schedule, runAt });
    if ("error" in timing) return res.status(400).json({ error: timing.error });

    const id = nanoid(10);
    const slug = await freeSlug(typeof req.body?.slug === "string" && req.body.slug ? req.body.slug : name);
    const conn = await getDb();
    await conn.run(
      `INSERT INTO routines
         (id, slug, name, schedule, run_at, instructions, fresh_session, next_run,
          report_channel, report_target)
       VALUES ($id, $slug, $name, $schedule, $runAt, $instructions, $freshSession, $nextRun, $reportChannel, $reportTarget)`,
      {
        id,
        slug,
        name: name.trim(),
        schedule: timing.schedule,
        runAt: timing.runAt,
        instructions: typeof instructions === "string" ? instructions.trim() : "",
        freshSession: freshSession ? 1 : 0,
        nextRun: timing.schedule ? (nextRun(parseCron(timing.schedule))?.toISOString() ?? null) : timing.runAt,
        reportChannel: report.channel,
        reportTarget: report.target,
      },
    );
    res.json(toApi((await rowById(id))!));
  });

  router.patch("/routines/:id", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    const { name, slug, schedule, runAt, instructions, enabled, freshSession } = req.body ?? {};
    const sets: string[] = [];
    const params: Record<string, any> = { id: row.id };
    const conn = await getDb();

    if (typeof slug === "string" && slug.trim() && slug.trim() !== row.slug) {
      const next = slugify(slug);
      if (!isValidSlug(next)) return res.status(400).json({ error: `"${slug}" is not a usable slug` });
      const clashReader = await conn.runAndReadAll(
        "SELECT id FROM routines WHERE slug = $slug AND id != $id",
        { slug: next, id: row.id },
      );
      if (clashReader.getRowObjectsJson().length) {
        return res.status(409).json({ error: `Another routine already uses "${next}"` });
      }
      sets.push("slug = $slug");
      params.slug = next;
    }
    if (typeof name === "string" && name.trim()) {
      sets.push("name = $name");
      params.name = name.trim();
    }
    // Setting one clears the other: a routine either repeats or happens once.
    if (typeof schedule === "string" || typeof runAt === "string") {
      const timing = readTiming({ schedule, runAt });
      if ("error" in timing) return res.status(400).json({ error: timing.error });
      sets.push("schedule = $schedule", "run_at = $runAt");
      params.schedule = timing.schedule;
      params.runAt = timing.runAt;
      // Re-arming a one-off that already ran: forget the old outcome, or it
      // would look done the moment it was saved.
      if (timing.runAt && timing.runAt !== row.run_at) {
        sets.push("last_run = NULL", "last_status = NULL", "last_output = NULL");
      }
    }
    if (typeof instructions === "string") {
      sets.push("instructions = $instructions");
      params.instructions = instructions.trim();
    }
    if (typeof req.body?.guard === "boolean") {
      sets.push("guard = $guard");
      params.guard = req.body.guard ? 1 : 0;
    }
    if (typeof req.body?.autonomous === "boolean") {
      sets.push("autonomous = $autonomous");
      params.autonomous = req.body.autonomous ? 1 : 0;
    }
    if ("reportChannel" in (req.body ?? {})) {
      const report = readReport(req.body);
      sets.push("report_channel = $reportChannel", "report_target = $reportTarget");
      params.reportChannel = report.channel;
      params.reportTarget = report.target;
    }
    if (typeof enabled === "boolean") {
      sets.push("enabled = $enabled");
      params.enabled = enabled ? 1 : 0;
    }
    if (typeof freshSession === "boolean") {
      sets.push("fresh_session = $freshSession");
      params.freshSession = freshSession ? 1 : 0;
    }

    if (sets.length) {
      sets.push("updated_at = now()");
      await conn.run(`UPDATE routines SET ${sets.join(", ")} WHERE id = $id`, params);
      await routineSupervisor.refreshSchedules();
    }
    res.json(toApi((await rowById(row.id))!));
  });

  router.delete("/routines/:id", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.json({ ok: true });
    // Its sessions are left alone: they are the record of what it did, and
    // deleting the schedule is not the same as wanting that gone.
    const conn = await getDb();
    await conn.run("DELETE FROM routines WHERE id = $id", { id: row.id });
    res.json({ ok: true, keptSessions: (await listRoutineSessions(row.slug)).length });
  });

  /** Run it now. Returns once the run finishes, which can be a while. */
  router.post("/routines/:id/run", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    try {
      res.json(toApi(await routineSupervisor.run(row, "manual")));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** What a schedule would do next, without saving it. */
  router.post("/routines/preview", (req, res) => {
    const schedule = req.body?.schedule;
    if (typeof schedule !== "string") return res.status(400).json({ error: "schedule required" });
    const bad = isValidCron(schedule);
    if (bad) return res.status(400).json({ error: bad });

    const cron = parseCron(schedule);
    const runs: string[] = [];
    let at = new Date();
    for (let i = 0; i < 5; i++) {
      const next = nextRun(cron, at);
      if (!next) break;
      runs.push(next.toISOString());
      at = next;
    }
    res.json({ expression: cron.expression, runs });
  });

  router.get("/routines/:id/sessions", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ sessions: await listRoutineSessions(row.slug) });
  });

  return router;
}
