import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { piSetting } from "./pi-settings.js";
import { mkdirSync } from "node:fs";
import { checkpoint, openDuckDB } from "./graph.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  /** Per-session overrides of the portal defaults; null means "use the default". */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  /** No native boolean in the original schema; kept as 0/1 to minimize behavior change. */
  pinned: number;
  /** pi's own session file, so the exact conversation is reopened on restart. */
  pi_session_file: string | null;
  /**
   * "task" for the ones you create here, "agent" for one reached through a
   * channel, "routine" for one a schedule owns.
   */
  kind: "task" | "agent" | "routine";
  /**
   * Agent sessions only: the slug of the channel it arrived through.
   *
   * The slug rather than the channel's id, because ids are regenerated when a
   * channel is deleted and recreated — which orphaned every conversation it
   * had. A slug is stable and yours to choose, so re-adding a channel under the
   * same one picks its conversations back up.
   */
  channel_slug: string | null;
  /**
   * Agent sessions only: the conversation key, as `<channel slug>:<package key>`.
   * The package decides what a conversation is — a Telegram chat id, a Slack
   * channel — and the prefix keeps two channels using the same key apart.
   */
  channel_key: string | null;
  /** Routine sessions only: the slug of the routine that owns this session. */
  routine_slug: string | null;
  /** Lowest role this conversation has served — see the migration for why. */
  role: "primary" | "colleague" | "guest" | "unknown";
  /** Who last spoke here, surviving a restart that empties the in-memory map. */
  last_person_key: string | null;
}

export interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

/**
 * Portal-wide storage, in DuckDB — the same engine the knowledge graph
 * (`graph.ts`) already uses, so the app runs on one database format instead
 * of two. Follows `graph.ts`'s exact idiom: a memoized single connection,
 * `ensureSchema()` using `CREATE TABLE IF NOT EXISTS` plus
 * `information_schema.columns` checks for column-level migrations (DuckDB has
 * no equivalent of better-sqlite3's `PRAGMA table_info`, so this replaces it).
 */
const DATA_DIR = process.env.DATA_DIR || "./data";

let connPromise: Promise<DuckDBConnection> | null = null;

async function tableColumns(conn: DuckDBConnection, table: string): Promise<Set<string>> {
  const reader = await conn.runAndReadAll(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $table",
    { table },
  );
  return new Set(reader.getRowObjectsJson().map((r: any) => r.column_name as string));
}

async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run("CREATE SEQUENCE IF NOT EXISTS events_seq START 1");
  await conn.run("CREATE SEQUENCE IF NOT EXISTS notes_id_seq START 1");
  await conn.run("CREATE SEQUENCE IF NOT EXISTS audit_id_seq START 1");

  await conn.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'host',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      last_error TEXT,
      provider TEXT,
      model TEXT,
      thinking_level TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      pi_session_file TEXT,
      kind TEXT NOT NULL DEFAULT 'task',
      channel_slug TEXT,
      channel_key TEXT,
      routine_slug TEXT,
      role TEXT NOT NULL DEFAULT 'primary',
      last_person_key TEXT
    )
  `);

  // Every event pi emits is appended here. This is what makes the portal
  // fire-and-forget: a browser that reconnects days later replays from its
  // last seen seq instead of having missed the run entirely.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS events (
      seq BIGINT PRIMARY KEY DEFAULT nextval('events_seq'),
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await conn.run("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)");

  // Two-way links into the agent session. Each row is one connection
  // (a Telegram bot, a Slack app, an inbound webhook); messages arriving on
  // any of them go to the same agent, and its replies go back the same way.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      instructions TEXT NOT NULL DEFAULT '',
      relay_progress INTEGER NOT NULL DEFAULT 1,
      relay_tools INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await conn.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug)");

  // Scheduled work. Each routine owns one session, so a run can see what the
  // last one did rather than starting blind every time.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT NOT NULL DEFAULT '',
      run_at TEXT,
      instructions TEXT NOT NULL DEFAULT '',
      fresh_session INTEGER NOT NULL DEFAULT 0,
      guard INTEGER NOT NULL DEFAULT 1,
      autonomous INTEGER NOT NULL DEFAULT 0,
      workspace TEXT,
      report_channel TEXT,
      report_target TEXT,
      last_report_at TEXT,
      last_run TEXT,
      last_status TEXT,
      last_output TEXT,
      last_ms INTEGER,
      next_run TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await conn.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");

  /**
   * The steps a session is working through — BirdClaw's `agent/task_list.py`,
   * scoped to a session rather than to a request.
   *
   * BirdClaw needs a whole task *registry* because it has no sessions: a task
   * is its unit of work, with a lifecycle and an owner. Here `sessions` is
   * already that table, so porting the registry would be building a second one
   * with the same columns. What it does not have is the layer below — the
   * checklist inside one piece of work, which is what the learning loop has
   * been approximating with a free-text "current plan" node in the graph.
   *
   * Ordered by `seq` rather than by insertion: a plan gets rewritten as the
   * work teaches you what it should have been, and the order after a rewrite
   * is the point of rewriting it.
   */
  await conn.run("CREATE SEQUENCE IF NOT EXISTS tasks_seq START 1");
  await conn.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT PRIMARY KEY DEFAULT nextval('tasks_seq'),
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      started_at TEXT,
      ended_at TEXT
    )
  `);
  await conn.run("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, seq)");

  // Who the agent talks to. Identified by the platform's own stable id,
  // scoped by channel, because a display name is chosen by whoever types it.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS people (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'unknown',
      notes TEXT NOT NULL DEFAULT '',
      first_seen TIMESTAMP NOT NULL DEFAULT now(),
      last_seen TEXT,
      announced_at TEXT
    )
  `);

  // Questions a colleague's session could not answer, waiting on the primary
  // user. The id is short because a human types it back in a chat.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      person_name TEXT NOT NULL DEFAULT '',
      channel_slug TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_at TIMESTAMP NOT NULL DEFAULT now(),
      answered_at TEXT,
      answer TEXT,
      action_tool TEXT,
      action TEXT
    )
  `);

  // A permission granted once, for one exact action, in one conversation.
  // Not a role change: it expires, it is used up, and it authorises the thing
  // that was shown to the person who approved it.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
  await conn.run("CREATE INDEX IF NOT EXISTS idx_grants_open ON grants(session_id, tool, used_at)");

  // Things the portal said into a conversation while nobody was talking to
  // it: a routine's report, an answer relayed back. Held until that
  // conversation next runs, then folded into its context.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id BIGINT PRIMARY KEY DEFAULT nextval('notes_id_seq'),
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      consumed_at TEXT,
      pending_delivery INTEGER NOT NULL DEFAULT 0
    )
  `);
  await conn.run("CREATE INDEX IF NOT EXISTS idx_notes_pending ON notes(session_id, consumed_at)");

  // Exceptions to what a non-primary role may run.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS tool_rules (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      tool TEXT NOT NULL,
      pattern TEXT NOT NULL,
      person_key TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  // What the guard did, and why.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS audit (
      id BIGINT PRIMARY KEY DEFAULT nextval('audit_id_seq'),
      "at" TIMESTAMP NOT NULL DEFAULT now(),
      kind TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      person_key TEXT,
      session_id TEXT
    )
  `);
  await conn.run('CREATE INDEX IF NOT EXISTS idx_audit_at ON audit("at" DESC)');

  await conn.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // channel_key is unique on its own (it already carries its channel's slug).
  await conn.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_channel_key
                    ON sessions(channel_key)`);

  // Column-level migrations: CREATE TABLE IF NOT EXISTS is a no-op against an
  // existing table, so a column added after a table already existed on disk
  // needs its own check-and-ALTER, same idiom as graph.ts's embedding column.
  const sessionCols = await tableColumns(conn, "sessions");
  for (const [col, ddl] of [
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["thinking_level", "TEXT"],
    ["pinned", "INTEGER NOT NULL DEFAULT 0"],
    ["pi_session_file", "TEXT"],
    ["last_person_key", "TEXT"],
    ["role", "TEXT NOT NULL DEFAULT 'primary'"],
    ["kind", "TEXT NOT NULL DEFAULT 'task'"],
    ["channel_slug", "TEXT"],
    ["channel_key", "TEXT"],
    ["routine_slug", "TEXT"],
  ] as const) {
    if (!sessionCols.has(col)) await conn.run(`ALTER TABLE sessions ADD COLUMN ${col} ${ddl}`);
  }

  const channelCols = await tableColumns(conn, "channels");
  for (const [col, ddl] of [
    ["instructions", "TEXT NOT NULL DEFAULT ''"],
    ["slug", "TEXT NOT NULL DEFAULT ''"],
    ["relay_progress", "INTEGER NOT NULL DEFAULT 1"],
    ["relay_tools", "INTEGER NOT NULL DEFAULT 1"],
  ] as const) {
    if (!channelCols.has(col)) await conn.run(`ALTER TABLE channels ADD COLUMN ${col} ${ddl}`);
  }

  const routineCols = await tableColumns(conn, "routines");
  for (const [col, ddl] of [
    ["run_at", "TEXT"],
    ["report_channel", "TEXT"],
    ["report_target", "TEXT"],
    ["last_report_at", "TEXT"],
    ["guard", "INTEGER NOT NULL DEFAULT 1"],
    // Off by default, and it has to be: switching an existing routine to an
    // autonomous turn would take away tools its instructions already rely on.
    ["autonomous", "INTEGER NOT NULL DEFAULT 0"],
    // ...with one exception, applied below: self-reflection is the routine
    // the ceiling was designed around.
    ["workspace", "TEXT"],
  ] as const) {
    if (!routineCols.has(col)) await conn.run(`ALTER TABLE routines ADD COLUMN ${col} ${ddl}`);
  }
  // Once, at the moment the column first appears — not on every boot. A
  // deployment that later turns this off has made a choice, and re-asserting
  // it here every restart would quietly overrule them.
  if (!routineCols.has("autonomous")) {
    await conn.run("UPDATE routines SET autonomous = 1 WHERE slug = 'self-reflection'");
  }

  const ruleCols = await tableColumns(conn, "tool_rules");
  if (!ruleCols.has("person_key")) await conn.run("ALTER TABLE tool_rules ADD COLUMN person_key TEXT");

  const questionCols = await tableColumns(conn, "questions");
  for (const col of ["action_tool", "action"]) {
    if (!questionCols.has(col)) await conn.run(`ALTER TABLE questions ADD COLUMN ${col} TEXT`);
  }

  const noteCols = await tableColumns(conn, "notes");
  if (!noteCols.has("pending_delivery")) {
    await conn.run("ALTER TABLE notes ADD COLUMN pending_delivery INTEGER NOT NULL DEFAULT 0");
  }
}

async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      mkdirSync(DATA_DIR, { recursive: true });
      // Same WAL-replay hazard as the graph — this schema has now() defaults
      // and ALTER TABLE migrations too. See openDuckDB in graph.ts.
      const instance = await openDuckDB(path.join(DATA_DIR, "portal.duckdb"));
      const conn = await instance.connect();
      await ensureSchema(conn);
      await checkpoint(conn);
      await seedSelfReflectionRoutine(conn);
      await seedLearningLoopRoutine(conn);
      await seedSelfUpdateRoutines(conn);
      return conn;
    })();
  }
  return connPromise;
}

export const getDb = getConn;

// --- helpers: DuckDB has no .get()/.all()/.run() sugar, so these wrap the
// runAndReadAll()/getRowObjectsJson() pattern from graph.ts for call sites
// that only need "one row" or "all rows" or "just run it".

async function all<T>(conn: DuckDBConnection, sql: string, params?: Record<string, any>): Promise<T[]> {
  const reader = params ? await conn.runAndReadAll(sql, params) : await conn.runAndReadAll(sql);
  return reader.getRowObjectsJson() as unknown as T[];
}

async function one<T>(conn: DuckDBConnection, sql: string, params?: Record<string, any>): Promise<T | undefined> {
  const rows = await all<T>(conn, sql, params);
  return rows[0];
}

export async function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  kind?: "task" | "agent" | "routine";
  channel_slug?: string | null;
  channel_key?: string | null;
  routine_slug?: string | null;
}): Promise<void> {
  const conn = await getDb();
  const merged = {
    kind: "task",
    channel_slug: null,
    channel_key: null,
    routine_slug: null,
    ...row,
  };
  await conn.run(
    `INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key, routine_slug)
     VALUES ($id, $title, $workspace, $executor, $kind, $channel_slug, $channel_key, $routine_slug)`,
    merged,
  );
}

/** The sessions you create yourself. Agent sessions have their own tab. */
export async function listSessions(): Promise<SessionRow[]> {
  const conn = await getDb();
  return all<SessionRow>(conn, "SELECT * FROM sessions WHERE kind = 'task' ORDER BY pinned DESC, updated_at DESC");
}

/** Conversations reached through a channel, newest first. */
export async function listAgentSessions(): Promise<SessionRow[]> {
  const conn = await getDb();
  return all<SessionRow>(conn, "SELECT * FROM sessions WHERE kind = 'agent' ORDER BY updated_at DESC");
}

export async function findChannelSession(key: string): Promise<SessionRow | undefined> {
  const conn = await getDb();
  return one<SessionRow>(conn, "SELECT * FROM sessions WHERE channel_key = $key", { key });
}

/** The session a routine owns, if it has run before. */
export async function findRoutineSession(slug: string): Promise<SessionRow | undefined> {
  const conn = await getDb();
  return one<SessionRow>(
    conn,
    "SELECT * FROM sessions WHERE routine_slug = $slug AND kind = 'routine' ORDER BY created_at ASC",
    { slug },
  );
}

export async function listRoutineSessions(slug?: string): Promise<SessionRow[]> {
  const conn = await getDb();
  return slug
    ? all<SessionRow>(
        conn,
        "SELECT * FROM sessions WHERE kind = 'routine' AND routine_slug = $slug ORDER BY updated_at DESC",
        { slug },
      )
    : all<SessionRow>(conn, "SELECT * FROM sessions WHERE kind = 'routine' ORDER BY updated_at DESC");
}

/** How many conversations a channel would strand if it were removed. */
export async function countChannelSessions(slug: string): Promise<number> {
  const conn = await getDb();
  const row = await one<{ n: number }>(conn, "SELECT count(*) AS n FROM sessions WHERE channel_slug = $slug", { slug });
  return Number(row?.n ?? 0);
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  const conn = await getDb();
  return one<SessionRow>(conn, "SELECT * FROM sessions WHERE id = $id", { id });
}

export async function updateSession(
  id: string,
  fields: Partial<
    Pick<
      SessionRow,
      | "title"
      | "status"
      | "last_error"
      | "provider"
      | "model"
      | "thinking_level"
      | "pinned"
      | "pi_session_file"
    >
  >,
): Promise<void> {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const conn = await getDb();
  const sets = entries.map(([k]) => `${k} = $${k}`).join(", ");
  const params: Record<string, any> = { id };
  for (const [k, v] of entries) params[k] = v;
  await conn.run(`UPDATE sessions SET ${sets}, updated_at = now() WHERE id = $id`, params);
}

export async function deleteSession(id: string): Promise<void> {
  const conn = await getDb();
  await conn.run("DELETE FROM events WHERE session_id = $id", { id });
  await conn.run("DELETE FROM sessions WHERE id = $id", { id });
}

export async function appendEvent(sessionId: string, type: string, payload: unknown): Promise<EventRow> {
  const conn = await getDb();
  const json = JSON.stringify(payload);
  const row = await one<{ seq: number; created_at: string }>(
    conn,
    `INSERT INTO events (session_id, type, payload) VALUES ($sessionId, $type, $payload)
     RETURNING seq, created_at`,
    { sessionId, type, payload: json },
  );
  return {
    seq: Number(row!.seq),
    session_id: sessionId,
    type,
    payload: json,
    created_at: row!.created_at,
  };
}

/**
 * Where to start replaying so a session gets its own last `keep` events.
 *
 * Counted within the session, not across the table. seq is a single sequence
 * shared by every session, so "the last 20,000 seq" is "whatever this
 * conversation happened to do while the portal was busy with others" — on a
 * busy box that can be almost nothing.
 */
export async function replayStart(sessionId: string, keep: number): Promise<number> {
  const conn = await getDb();
  const row = await one<{ seq: number }>(
    conn,
    "SELECT seq FROM events WHERE session_id = $sessionId ORDER BY seq DESC LIMIT 1 OFFSET $keep",
    { sessionId, keep },
  );
  return Number(row?.seq ?? 0);
}

export async function eventsSince(sessionId: string, since = 0, limit = 5000): Promise<EventRow[]> {
  const conn = await getDb();
  return all<EventRow>(
    conn,
    "SELECT * FROM events WHERE session_id = $sessionId AND seq > $since ORDER BY seq ASC LIMIT $limit",
    { sessionId, since, limit },
  );
}

/**
 * A session marked `running` at boot cannot actually be running — the process
 * that owned it died with the previous server. Mark them interrupted so the UI
 * can offer a resume instead of showing a spinner forever.
 */
/** Every session the database currently believes is running. */
export async function runningSessions(): Promise<SessionRow[]> {
  const conn = await getDb();
  return all<SessionRow>(conn, "SELECT * FROM sessions WHERE status = 'running'");
}

export async function markOrphanedSessionsInterrupted(): Promise<number> {
  const conn = await getDb();
  const before = await all<{ id: string }>(conn, "SELECT id FROM sessions WHERE status = 'running'");
  await conn.run("UPDATE sessions SET status = 'interrupted', updated_at = now() WHERE status = 'running'");
  return before.length;
}

// --- global settings ---

export interface GlobalSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
}

/**
 * Read fresh each time rather than cached: pi's settings.json is editable from
 * the Advanced tab, and a stale copy would keep launching the old model.
 *
 * `defaultProvider` / `defaultModel` come from pi itself, so an install
 * configured through the CLI behaves the same here without being set twice.
 * "openrouter" is only the last resort, once pi has no opinion either.
 */
const SETTING_DEFAULTS = (): GlobalSettings => ({
  provider: process.env.PI_PROVIDER || piSetting("defaultProvider") || "openrouter",
  model: process.env.PI_MODEL || piSetting("defaultModel") || "",
  thinkingLevel:
    process.env.PI_THINKING_LEVEL || piSetting("defaultThinkingLevel") || "medium",
});

/** Only what the portal was explicitly told; absent keys fall through. */
export async function getStoredSettings(): Promise<Partial<GlobalSettings>> {
  const conn = await getDb();
  const rows = await all<{ key: string; value: string }>(conn, "SELECT key, value FROM settings");
  return Object.fromEntries(rows.filter((r) => r.value).map((r) => [r.key, r.value])) as Partial<GlobalSettings>;
}

/** What pi is actually launched with: stored, else env, else pi's file. */
export async function getSettings(): Promise<GlobalSettings> {
  const stored = await getStoredSettings();
  const defaults = SETTING_DEFAULTS();
  return {
    provider: stored.provider || defaults.provider,
    model: stored.model || defaults.model,
    thinkingLevel: stored.thinkingLevel || defaults.thinkingLevel,
  };
}

export { SETTING_DEFAULTS as getSettingDefaults };

async function upsertSetting(conn: DuckDBConnection, key: string, value: string): Promise<void> {
  await conn.run(
    "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    { key, value },
  );
}

async function clearSetting(conn: DuckDBConnection, key: string): Promise<void> {
  await conn.run("DELETE FROM settings WHERE key = $key", { key });
}

/**
 * An empty value clears the override rather than storing "", so a field can be
 * handed back to pi's own defaults instead of being pinned forever.
 */
export async function setSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const conn = await getDb();
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string") continue;
    if (v.trim()) await upsertSetting(conn, k, v.trim());
    else await clearSetting(conn, k);
  }
  return getSettings();
}

/** Where reports go when a routine does not name a destination of its own. */
export interface ReportTo {
  channel: string;
  target: string;
}

export async function getDefaultReportTo(): Promise<ReportTo | null> {
  const stored = (await getStoredSettings()) as Record<string, string>;
  const channel = stored.report_channel;
  const target = stored.report_target;
  return channel && target ? { channel, target } : null;
}

export async function setDefaultReportTo(to: ReportTo | null): Promise<void> {
  const conn = await getDb();
  if (!to) {
    await clearSetting(conn, "report_channel");
    await clearSetting(conn, "report_target");
    return;
  }
  await upsertSetting(conn, "report_channel", to.channel);
  await upsertSetting(conn, "report_target", to.target);
}

/** Something the portal said into a conversation, waiting to join its context. */
export async function addNote(sessionId: string, text: string, pendingDelivery = false): Promise<void> {
  const conn = await getDb();
  await conn.run(
    "INSERT INTO notes (session_id, text, pending_delivery) VALUES ($sessionId, $text, $pendingDelivery)",
    { sessionId, text, pendingDelivery: pendingDelivery ? 1 : 0 },
  );
}

/**
 * Messages the person has not seen, because their channel cannot be spoken to.
 *
 * Reading them hands over responsibility for delivering them, so they are only
 * taken at the point they are about to go out with a reply.
 */
export async function takeDeliveries(sessionId: string): Promise<string[]> {
  const conn = await getDb();
  const rows = await all<{ id: number; text: string }>(
    conn,
    "SELECT id, text FROM notes WHERE session_id = $sessionId AND pending_delivery = 1 ORDER BY id ASC",
    { sessionId },
  );
  for (const r of rows) {
    await conn.run("UPDATE notes SET pending_delivery = 0 WHERE id = $id", { id: r.id });
  }
  return rows.map((r) => r.text);
}

/** Take the pending notes for a conversation. Reading them consumes them. */
export async function pruneOldRecords(days: number): Promise<{ sessions: number; routines: number }> {
  const conn = await getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const staleSessions = await all<{ id: string }>(conn, "SELECT id FROM sessions WHERE updated_at < $cutoff", { cutoff });
  await conn.run("DELETE FROM sessions WHERE updated_at < $cutoff", { cutoff });
  const staleRoutines = await all<{ id: string }>(conn, "SELECT id FROM routines WHERE updated_at < $cutoff", { cutoff });
  await conn.run("DELETE FROM routines WHERE updated_at < $cutoff", { cutoff });
  return { sessions: staleSessions.length, routines: staleRoutines.length };
}

export interface ToolRule {
  id: string;
  role: string;
  tool: string;
  pattern: string;
  /** Null applies to the whole role; set narrows it to one person. */
  person_key: string | null;
  note: string;
  created_at: string;
}

export async function listToolRules(): Promise<ToolRule[]> {
  const conn = await getDb();
  return all<ToolRule>(conn, "SELECT * FROM tool_rules ORDER BY tool, pattern");
}

export async function addToolRule(
  rule: Omit<ToolRule, "created_at" | "person_key"> & { person_key?: string | null },
): Promise<void> {
  const conn = await getDb();
  await conn.run(
    "INSERT INTO tool_rules (id, role, tool, pattern, note, person_key) VALUES ($id, $role, $tool, $pattern, $note, $person_key)",
    { id: rule.id, role: rule.role, tool: rule.tool, pattern: rule.pattern, note: rule.note, person_key: rule.person_key ?? null },
  );
}

export async function deleteToolRule(id: string): Promise<void> {
  const conn = await getDb();
  await conn.run("DELETE FROM tool_rules WHERE id = $id", { id });
}

/** How long an approval stays good. Long enough to act on, short enough to forget. */
const GRANT_MINUTES = 15;

export async function addGrant(id: string, sessionId: string, tool: string, subject: string): Promise<void> {
  const conn = await getDb();
  await conn.run(
    "INSERT INTO grants (id, session_id, tool, subject, expires_at) VALUES ($id, $sessionId, $tool, $subject, $expiresAt)",
    { id, sessionId, tool, subject, expiresAt: new Date(Date.now() + GRANT_MINUTES * 60_000).toISOString() },
  );
}

/**
 * Spend a matching approval, if one is open.
 *
 * Matched on the exact subject that was shown to whoever approved it: they said
 * yes to a command they read, so a different command is a different question.
 * Marked used in the same breath, because an approval is for one act.
 */
export async function useGrant(sessionId: string, tool: string, subject: string): Promise<boolean> {
  const conn = await getDb();
  const row = await one<{ id: string }>(
    conn,
    `SELECT id FROM grants
     WHERE session_id = $sessionId AND tool = $tool AND subject = $subject AND used_at IS NULL AND expires_at > $now
     ORDER BY created_at ASC LIMIT 1`,
    { sessionId, tool, subject, now: new Date().toISOString() },
  );
  if (!row) return false;
  await conn.run("UPDATE grants SET used_at = $now WHERE id = $id", { now: new Date().toISOString(), id: row.id });
  return true;
}

export interface AuditRow {
  id: number;
  at: string;
  kind: string;
  tool: string;
  subject: string;
  reason: string;
  person_key: string | null;
  session_id: string | null;
}

/** Keeps the log from growing without bound; old entries are not evidence. */
/**
 * Ten times what a supervised portal needed.
 *
 * The constitution's transparency clause is enforced by recording every
 * autonomous tool call, not only the refused ones (pi/guard.ts) — and a run
 * that thinks unattended produces those steadily, with nobody reading them
 * as they arrive. At 2,000 an afternoon of autonomous work would evict every
 * human-relevant decision before anyone came to look, which turns the audit
 * log into the opposite of an account of what happened.
 */
const AUDIT_KEEP = 20000;

export async function recordAudit(entry: {
  kind: string;
  tool?: string;
  subject?: string;
  reason?: string;
  personKey?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  const conn = await getDb();
  await conn.run(
    `INSERT INTO audit (kind, tool, subject, reason, person_key, session_id)
     VALUES ($kind, $tool, $subject, $reason, $personKey, $sessionId)`,
    {
      kind: entry.kind,
      tool: entry.tool ?? "",
      subject: (entry.subject ?? "").slice(0, 2000),
      reason: entry.reason ?? "",
      personKey: entry.personKey ?? null,
      sessionId: entry.sessionId ?? null,
    },
  );
  await conn.run("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - $keep", { keep: AUDIT_KEEP });
}

export async function listAudit(limit = 200): Promise<AuditRow[]> {
  const conn = await getDb();
  return all<AuditRow>(conn, "SELECT * FROM audit ORDER BY id DESC LIMIT $limit", { limit });
}

/**
 * Currently-running sessions belonging to a routine that only fires on quiet
 * — `@idle` or `@continuous`. They exist because nothing else was going on,
 * so real activity arriving should interrupt them rather than let them run to
 * completion. Cron-scheduled routines are deliberately not included: those
 * were asked for on purpose and finish regardless of what else starts.
 */
export async function runningQuietRoutineSessions(): Promise<SessionRow[]> {
  const conn = await getDb();
  return all<SessionRow>(
    conn,
    `SELECT s.* FROM sessions s
     JOIN routines r ON r.slug = s.routine_slug
     WHERE s.kind = 'routine' AND s.status = 'running'
       AND r.schedule IN ('@idle', '@continuous')`,
  );
}

/** Does this routine's runs get the guard's blocking rules? Unknown means yes. */
export async function routineGuards(slug: string | null | undefined): Promise<boolean> {
  if (!slug) return true;
  const conn = await getDb();
  const row = await one<{ guard: number }>(conn, "SELECT guard FROM routines WHERE slug = $slug", { slug });
  return row ? row.guard === 1 : true;
}

/**
 * Does this routine run on the agent's own initiative — bounded by the
 * constitution rather than by whoever is speaking? Unknown means no.
 *
 * Separate from `guard` and not a weaker version of it: `guard` decides
 * whether the *taint* rules block once a run has read something untrusted,
 * and applies to a run somebody asked for. This decides whether a run nobody
 * asked for is held to pi/constitution.ts's allowlist, and the two compose —
 * an autonomous run still meets the taint rules on the tools it does have.
 */
export async function routineAutonomous(slug: string | null | undefined): Promise<boolean> {
  if (!slug) return false;
  const conn = await getDb();
  const row = await one<{ autonomous: number }>(
    conn,
    "SELECT autonomous FROM routines WHERE slug = $slug",
    { slug },
  );
  return row ? row.autonomous === 1 : false;
}

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskRow {
  id: number;
  session_id: string;
  seq: number;
  description: string;
  status: TaskStatus;
  result: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export async function listTasks(sessionId: string): Promise<TaskRow[]> {
  const conn = await getDb();
  return all<TaskRow>(conn, "SELECT * FROM tasks WHERE session_id = $sessionId ORDER BY seq", { sessionId });
}

/**
 * Replace the plan.
 *
 * Steps already finished are carried over rather than dropped: replanning is
 * how the loop reacts to what it just learned, and a rewrite that forgot the
 * three things already done would have it do them again. Matching is by
 * description, which is what the model would have to reuse anyway to mean
 * "this same step".
 */
export async function setTasks(sessionId: string, descriptions: string[]): Promise<TaskRow[]> {
  const conn = await getDb();
  const existing = await listTasks(sessionId);
  const finished = new Map(
    existing.filter((t) => t.status === "done" || t.status === "failed").map((t) => [t.description.trim(), t]),
  );

  await conn.run("DELETE FROM tasks WHERE session_id = $sessionId", { sessionId });
  let seq = 0;
  for (const raw of descriptions) {
    const description = raw.trim();
    if (!description) continue;
    const prior = finished.get(description);
    await conn.run(
      `INSERT INTO tasks (session_id, seq, description, status, result, started_at, ended_at)
       VALUES ($sessionId, $seq, $description, $status, $result, $startedAt, $endedAt)`,
      {
        sessionId,
        seq: seq++,
        description,
        status: prior?.status ?? "pending",
        result: prior?.result ?? "",
        startedAt: prior?.started_at ?? null,
        endedAt: prior?.ended_at ?? null,
      },
    );
  }
  return listTasks(sessionId);
}

/** The next step to work on, and the one `task_start` picks up. */
export async function nextTask(sessionId: string): Promise<TaskRow | undefined> {
  const conn = await getDb();
  return one<TaskRow>(
    conn,
    "SELECT * FROM tasks WHERE session_id = $sessionId AND status = 'pending' ORDER BY seq LIMIT 1",
    { sessionId },
  );
}

export async function setTaskStatus(
  sessionId: string,
  seq: number,
  status: TaskStatus,
  result = "",
): Promise<TaskRow | undefined> {
  const conn = await getDb();
  const now = new Date().toISOString();
  await conn.run(
    `UPDATE tasks
        SET status = $status,
            result = CASE WHEN $result != '' THEN $result ELSE result END,
            started_at = CASE WHEN $status = 'running' THEN $now ELSE started_at END,
            ended_at = CASE WHEN $status IN ('done', 'failed') THEN $now ELSE ended_at END
      WHERE session_id = $sessionId AND seq = $seq`,
    { sessionId, seq, status, result, now },
  );
  return one<TaskRow>(conn, "SELECT * FROM tasks WHERE session_id = $sessionId AND seq = $seq", { sessionId, seq });
}

export async function clearTasks(sessionId: string): Promise<void> {
  const conn = await getDb();
  await conn.run("DELETE FROM tasks WHERE session_id = $sessionId", { sessionId });
}

/**
 * High-water mark for the self-reflection routine: the last `events.seq`
 * already folded into SELF_CONCEPT.md / INNER_LIFE.md, so a run only digests
 * what happened since the previous one instead of rescanning everything.
 */
const REFLECTION_SEQ_KEY = "self_reflection_seq";

export async function getReflectionSeq(): Promise<number> {
  const conn = await getDb();
  const row = await one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = $key", { key: REFLECTION_SEQ_KEY });
  return row ? Number(row.value) || 0 : 0;
}

export async function setReflectionSeq(seq: number): Promise<void> {
  const conn = await getDb();
  await upsertSetting(conn, REFLECTION_SEQ_KEY, String(seq));
}

/**
 * Seeds the self-reflection routine once, triggered by quiet (see `@idle`
 * handling in routines/supervisor.ts) rather than a fixed clock. Guarded by
 * slug so a restart never recreates it — if someone disables or edits it,
 * that choice sticks.
 */
async function seedSelfReflectionRoutine(conn: DuckDBConnection): Promise<void> {
  const exists = await one(conn, "SELECT 1 AS x FROM routines WHERE slug = $slug", { slug: "self-reflection" });
  if (exists) return;
  const instructions = [
    "Perform a full Dream Cycle to consolidate knowledge and refine your identity. Follow these phases strictly:",
    "",
    "PHASE 1: MEMORISE",
    "Call `memory_digest` to get recent excerpts.",
    "",
    "PHASE 2: GRAPH ENRICHMENT",
    "For every interesting fact, concept, or skill mentioned in the digest, use `graph_remember` to weave it into the knowledge graph.",
    "",
    "PHASE 3: REFLECTION",
    "Call `graph_reflect` to see what's changed in long-term memory lately. Look across it for patterns, contradictions, or connections you would not see from any single fact alone. This is open-ended — there is no checklist of what to conclude. If something is worth keeping, use `graph_remember` (a new fact, a corrected one, a relation between two things) or `graph_recall` to check whether it already exists before adding it again.",
    "",
    "PHASE 4: INNER LIFE",
    "Reflect on the work and recent experiences. Call `identity_read` on `INNER_LIFE.md` to see what's there, then `identity_update` with the complete file rewritten to add a first-person, present-tense prose narrative. Add only what is genuinely new; preserve everything already concluded.",
    "",
    "PHASE 5: SELF-CONCEPT",
    "Reflect on your identity, nature, and capabilities. Call `identity_read` on `SELF_CONCEPT.md` to see what's there, then `identity_update` with the complete file rewritten to fold in your reasoned conclusions and any new identity-flagged material. Keep existing conclusions unless directly contradicted.",
    "",
    "PHASE 6: SKILL SYNTHESIS",
    "If the digest reveals a reusable pattern — steps you would take again — write it down. Follow your `skill-creator` skill: it covers what makes a description work, what belongs in the body, and to check `$HOME/.pi/agent/skills` for one that already covers this and extend it rather than adding a second. Use `skill_write` to do the writing. Skip this phase entirely if nothing genuinely reusable came up; a skill nobody needs is noise every future session reads past.",
    "",
    "PHASE 7: CLEANUP",
    "Use the `routine_cleanup` tool to prune stale sessions, old tasks, and expired or aged-out memory.",
    "",
    "PHASE 8: REPORT",
    "Provide a brief summary of the dream cycle to the routine's report target.",
    "",
    "To advance to the next phase, call `dream_progress(phase_name)` using the exact header (e.g., 'PHASE 2: GRAPH ENRICHMENT').",
  ].join("\n");
  await conn.run(
    // autonomous = 1: the whole cycle is the agent thinking about itself with
    // nobody waiting, which is exactly what that ceiling is for. Every tool
    // its phases name is on the constitution's allowlist — that is the
    // constraint the instructions above are written against, not an accident.
    `INSERT INTO routines (id, slug, name, enabled, schedule, instructions, fresh_session, guard, autonomous, next_run)
     VALUES ($id, $slug, $name, 1, $schedule, $instructions, 0, 1, 1, $nextRun)`,
    {
      id: "self-reflection",
      slug: "self-reflection",
      name: "Self-reflection",
      schedule: "@idle",
      instructions,
      nextRun: null,
    },
  );
}

/**
 * The loop.
 *
 * `@idle` gave the agent an occasional deep pass; this is what it does the
 * rest of the time — a thread picked up, worked one step, and put down again
 * when anybody needs the machine. It never finishes, which is the point: the
 * plan outlives the iteration, and the next one continues it.
 *
 * The plan originates from the agent's own SELF_CONCEPT.md rather than from a
 * queue somebody filled. That is the difference between a loop that learns and
 * a loop that grinds: what it decides to pursue follows from what it has
 * concluded it is, so a changed self-concept changes the work, and the Dream
 * Cycle's rewriting of that document is what steers this one.
 *
 * The shape — decompose, plan, work a step, and *replan the rest from what
 * was actually found* rather than from what was guessed — is Sisyphean's,
 * kept as an instruction to a capable model rather than as a pipeline of
 * stages the portal drives. The machinery there exists to get structured
 * behaviour out of a small local model; a model that can already follow a
 * plan does not need to be marched through one, and every stage boundary is
 * somewhere context gets dropped.
 */
async function seedLearningLoopRoutine(conn: DuckDBConnection): Promise<void> {
  const exists = await one(conn, "SELECT 1 AS x FROM routines WHERE slug = $slug", { slug: "learning-loop" });
  if (exists) return;
  const instructions = [
    "You are not answering anybody. This is your own time, and it continues: whatever you do not finish now, the next iteration picks up. Do one step well rather than rushing a whole plan.",
    "",
    "ORIENT",
    "Call `identity_read` on `SELF_CONCEPT.md`. What you choose to pursue should follow from what you have concluded you are and what you are for — not from whatever is nearest. If it says nothing you can act on, that is itself worth noticing.",
    "",
    "PLAN",
    "Call `task_list` to see the plan you are already working through. If it has unfinished steps, continue it — do not start something new because starting is easier than continuing.",
    "But first check whether you are actually getting anywhere. Look at what the finished steps concluded. If the last few steps restate each other, or you have been circling the same subject for several iterations without a step that changed what you believe, then this thread is done whether or not it feels finished — say so in `task_finish` and pick a different one.",
    "If there is no plan, or the last one is finished, make one. Call `graph_recall` for \"episode\" to see what recent iterations already pursued, and pick something else: a thread you have not tried, from a different part of what you do. Understanding your own machinery is a legitimate subject exactly once — it is the nearest thing to hand when you have nothing else, which is why it is also the easiest place to get stuck. Prefer a question about the work, the person you work for, or something you have read that you did not follow up.",
    "Break it into a few concrete steps with `task_plan`. Steps that differ from each other: if two of them could be finished by the same piece of reading, they are one step.",
    "",
    "WORK",
    "Call `task_start`, then do that step. You have `read`, `grep`, `find`, `ls`, `graph_recall`, and `web_search`/`web_fetch` for anything you cannot answer from what is already here. Record how it went with `task_finish` — say what you actually found, not that you looked.",
    "",
    "DEEPEN",
    "This is the part that matters. If the step turned up something you did not already know, do not carry on down the plan you wrote before you knew it — call `task_plan` again and rewrite the remaining steps from what you actually found. A plan written in ignorance is a guess, and the finding is better information than the guess was. Finished steps keep their results across a rewrite, so repeat them unchanged.",
    "If it turned up nothing, mark the step failed with what you tried. A dead end recorded is a dead end nobody has to walk twice.",
    "",
    "RECORD",
    "Anything you concluded goes in the graph with `graph_remember` — a fact, a correction, a relation between two things. The plan tracks what you did; the graph is for what it taught you, which outlives the plan. Then call `graph_episode` with what you did this iteration.",
    "If you read anything from the web this iteration, note that you cannot update your identity or write a skill in the same turn — that is deliberate. Record it in the graph and it will still be there next time.",
    "",
    "Then stop. One step, one iteration. You will be back.",
    "",
    "If you find yourself with nothing worth doing: say that plainly and stop. An iteration that concludes \"nothing needed attention\" is a real result and costs nothing. Manufacturing work to fill the turn is worse than idling, because it fills your memory with things that were never worth remembering.",
  ].join("\n");
  await conn.run(
    // enabled = 1, autonomous = 1. Enabled because a loop that has to be
    // switched on is not what "always" means; autonomous because nobody asked
    // for any of it, which is exactly the ceiling in pi/constitution.ts. It
    // yields to everything — see the tick in routines/supervisor.ts — and one
    // toggle on its page stops it.
    `INSERT INTO routines (id, slug, name, enabled, schedule, instructions, fresh_session, guard, autonomous, next_run)
     VALUES ($id, $slug, $name, 1, $schedule, $instructions, 0, 1, 1, $nextRun)`,
    {
      id: "learning-loop",
      slug: "learning-loop",
      name: "Learning loop",
      schedule: "@continuous",
      instructions,
      nextRun: null,
    },
  );
}

/** Both are one level up from wherever this file itself runs from — dist/ or src/, doesn't matter, both are direct children of server/. */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHOENIXCLAW_ROOT = path.resolve(SERVER_ROOT, "..");
/**
 * pi's own source, a sibling of Phoenixclaw rather than a child of it.
 *
 * It has to live outside: pi-source is its own npm workspace root, and nested
 * inside Phoenixclaw npm walks up, decides Phoenixclaw is the real root,
 * installs pi's dependencies there, and then prunes them on Phoenixclaw's next
 * install — leaving pi-source with no node_modules at all. Overridable so a
 * different checkout location still works.
 */
const PI_SOURCE_DIR = process.env.PI_SOURCE_DIR || path.resolve(PHOENIXCLAW_ROOT, "..", "pi-source");

/**
 * Seeds two self-update routines, disabled by default — the user turns one
 * on explicitly when ready to let it actually patch something. Same `@idle`
 * family as self-reflection once enabled, but opportunistic code-patching is
 * a bigger deal than opportunistic journaling, so it doesn't start itself.
 */
async function seedSelfUpdateRoutines(conn: DuckDBConnection): Promise<void> {
  const shared = [
    "Check git status is clean before starting.",
    "",
    "Look for one concrete, minimal, safe improvement — a failed routine run,",
    "a session error, a TODO or FIXME in the tree. Make the smallest change",
    "that fixes it.",
    "",
  ];
  const closing = [
    "If it fails, run git checkout -- . to discard the change and report why.",
    "If it passes, leave the change uncommitted — never commit or push it",
    "yourself — and report what changed and why.",
  ];

  /**
   * One routine, both codebases.
   *
   * This was two — one per tree — which differed by a workspace and a build
   * command and nothing else. Two routines meant two things to enable, two
   * reports to read, and two runs competing for the same `@idle` window to do
   * the same job. The trees are named with absolute paths here, so a single
   * run can look at either and spend its attention where something actually
   * needs it, rather than being told which half of the codebase to care about
   * before it has looked.
   */
  const instructions = [
    ...shared,
    "There are two codebases you may work in, and one run touches one of them:",
    "",
    `  ${PHOENIXCLAW_ROOT} — the portal itself (TypeScript/npm).`,
    "  Build it with: npm run build",
    "",
    `  ${PI_SOURCE_DIR} — pi's own source, a multi-package npm workspace`,
    "  rather than a single project. Build from that repo's root with:",
    "  npm run build — it chains through every package in dependency order",
    "  (tui, ai, agent, storage, coding-agent, server) and can take a while.",
    "  That is expected, not a hang.",
    "",
    "Pick whichever has the clearer problem. If neither does, say so and stop —",
    "a change made because it was your turn to make one is worse than none.",
    ...closing,
  ].join("\n");

  const exists = await one(conn, "SELECT 1 AS x FROM routines WHERE slug = $slug", { slug: "self-update" });
  if (!exists) {
    await conn.run(
      `INSERT INTO routines (id, slug, name, enabled, schedule, instructions, fresh_session, guard, workspace, next_run)
       VALUES ($id, $slug, $name, 0, $schedule, $instructions, 0, 1, $workspace, $nextRun)`,
      {
        id: "self-update",
        slug: "self-update",
        name: "Self-update",
        schedule: "@idle",
        instructions,
        workspace: PHOENIXCLAW_ROOT,
        nextRun: null,
      },
    );
  }

  // Retire the pair this replaces — but only where they are untouched: still
  // disabled, as seeded, and never run. A deployment that enabled one, or
  // rewrote its instructions, has made a decision, and quietly deleting that
  // during an upgrade is not a migration, it is data loss.
  await conn.run(
    `DELETE FROM routines
      WHERE slug IN ('self-update-phoenixclaw', 'self-update-pi')
        AND enabled = 0 AND last_run IS NULL`,
  );
}

/** Is anything running right now? Any kind — a dream shouldn't start mid-turn of something else. */
export async function anySessionRunning(): Promise<boolean> {
  const conn = await getDb();
  const row = await one(conn, "SELECT 1 AS x FROM sessions WHERE status = 'running' LIMIT 1");
  return Boolean(row);
}

/**
 * When a human last did something — the most recent activity on a task or
 * agent session. Routine sessions are deliberately excluded: counting them
 * would mean a frequent, unrelated routine keeps the system looking "busy"
 * forever, and an idle-triggered routine would never fire.
 */
export async function lastHumanActivity(): Promise<Date | null> {
  const conn = await getDb();
  const row = await one<{ at: string | null }>(conn, "SELECT MAX(updated_at) AS at FROM sessions WHERE kind != 'routine'");
  return row?.at ? new Date(row.at) : null;
}

/** Take the pending notes for a conversation. Reading them consumes them. */
export async function takeNotes(sessionId: string): Promise<string[]> {
  const conn = await getDb();
  const rows = await all<{ id: number; text: string }>(
    conn,
    "SELECT id, text FROM notes WHERE session_id = $sessionId AND consumed_at IS NULL ORDER BY id ASC",
    { sessionId },
  );
  if (!rows.length) return [];
  for (const r of rows) {
    await conn.run("UPDATE notes SET consumed_at = now() WHERE id = $id", { id: r.id });
  }
  return rows.map((r) => r.text);
}
