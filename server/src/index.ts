import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import {
  trimEventLog,
  closeDb,
  createSession,
  deleteSession,
  eventsSince,
  replayStart,
  getSession,
  listAgentSessions,
  listSessions,
  updateSession,
} from "./db.js";
import { listTasks } from "./db.js";
import { agentHome, resolveChannelSession } from "./agent.js";
import { runWizard, type WizardInput } from "./agent-setup.js";
import { identityStatus, writeIdentity, migrateIdentityFromDisk, stopIdentityNamingFiles, relocateMirrors, inviteNameChoice, adoptDiskEdits } from "./identity.js";
import { backfillEmbeddings, unembeddedCount, closeGraph } from "./graph.js";
import { sessions, EXECUTOR_KIND } from "./session-manager.js";
import { mainConversation } from "./mirror.js";
import { authEnabled, checkPassword, isAuthed, issueCookie, requireAuth } from "./auth.js";
import { packagesRouter } from "./api/packages.js";
import { extensionsRouter } from "./api/extensions.js";
import { channelsRouter } from "./api/channels.js";
import { routinesRouter } from "./api/routines.js";
import { skillsRouter } from "./api/skills.js";
import { peopleRouter } from "./api/people.js";
import { memoryRouter } from "./api/memory.js";
import { healthRouter } from "./api/health.js";
import { routineSupervisor } from "./routines/supervisor.js";
import { channelSupervisor } from "./channels/supervisor.js";
import { piSettingsPath } from "./pi-settings.js";
import { getDb } from "./db.js";
import { getBuiltinCommands } from "./pi/builtins.js";
import { isValidSlug, slugify } from "./slug.js";
import { getSettingDefaults, getSettings, getStoredSettings, setSettings } from "./db.js";

// WORKSPACE_ROOT is the new name; WORKSPACE_ROOT still works for existing deploys.
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || "/workspaces"
);
const PORT = Number(process.env.PORT || 4100);
/**
 * How much of a long conversation a fresh page load replays.
 *
 * Not a correctness limit — a reconnect with a cursor still receives everything
 * it missed. This is only how far back a browser opening the session cold has
 * to scroll, and shipping 70,000 events to render a chat window is its own kind
 * of broken.
 */
const REPLAY_EVENTS = 20_000;
/** Persistent place for CLIs, kept on PATH so pi and its tools can reach them. */
const BIN_DIR = path.resolve(process.env.BIN_DIR || "/data/bin");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// --- auth ---

app.get("/api/auth/status", (req, res) => {
  res.json({ authRequired: authEnabled, authed: isAuthed(req) });
});

app.post("/api/auth/login", (req, res) => {
  if (!authEnabled) return res.json({ ok: true });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  issueCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

// --- global settings (defaults for every new session) ---

app.get("/api/settings", async (_req, res) => {
  // `stored` and `defaults` are separated so the UI can show an empty field
  // with the inherited value as a placeholder, instead of pre-filling it and
  // turning the next Save into a permanent pin.
  res.json({
    settings: await getSettings(),
    stored: await getStoredSettings(),
    defaults: getSettingDefaults(),
    piSettingsPath: piSettingsPath(),
    executor: EXECUTOR_KIND,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

app.put("/api/settings", async (req, res) => {
  const { provider, model, thinkingLevel } = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof provider === "string") patch.provider = provider.trim();
  if (typeof model === "string") patch.model = model.trim();
  if (typeof thinkingLevel === "string") patch.thinkingLevel = thinkingLevel.trim();
  const settings = await setSettings(patch);
  // Existing sessions keep their own settings; this applies to sessions started
  // from here on, which matches how the TUI treats a changed default.
  res.json({ settings, note: "Applies to newly started sessions" });
});

// --- workspaces ---

/** Directories pi can be pointed at. Anything directly under WORKSPACE_ROOT. */
app.get("/api/workspaces", (_req, res) => {
  if (!existsSync(WORKSPACE_ROOT)) return res.json({ root: WORKSPACE_ROOT, workspaces: [] });
  const workspaces = readdirSync(WORKSPACE_ROOT)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(path.join(WORKSPACE_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({
      name,
      path: path.join(WORKSPACE_ROOT, name),
      isGit: existsSync(path.join(WORKSPACE_ROOT, name, ".git")),
    }));
  res.json({ root: WORKSPACE_ROOT, workspaces });
});

app.post("/api/workspaces", (req, res) => {
  const raw = req.body?.name;
  if (typeof raw !== "string" || !raw.trim()) {
    return res.status(400).json({ error: "name required" });
  }
  // "Cool Project" becomes the directory "cool-project", and that same slug
  // becomes the session title — one name drives both.
  const name = slugify(raw);
  if (!isValidSlug(name)) {
    return res.status(400).json({ error: `"${raw}" does not produce a usable folder name` });
  }

  const target = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(target) !== target || !target.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "Invalid workspace name" });
  }
  if (existsSync(target)) return res.status(409).json({ error: `Workspace "${name}" already exists` });

  try {
    mkdirSync(target, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
  res.json({ name, path: target, isGit: false });
});

// --- sessions ---

/** Pinned is stored as 0/1; the API speaks booleans. */
const toApi = (s: Awaited<ReturnType<typeof getSession>> & {}) => ({
  ...s,
  pinned: Boolean(s.pinned),
  live: sessions.isRunning(s.id),
  // Accumulated across every conversation this session has had, including ones
  // retired for filling up — see addUsage.
  usage: { tokensIn: Number(s.tokens_in ?? 0), tokensOut: Number(s.tokens_out ?? 0), cost: Number(s.cost ?? 0) },
});

app.get("/api/sessions", async (_req, res) => {
  res.json({ sessions: (await listSessions()).map(toApi), executor: EXECUTOR_KIND });
});

/**
 * Conversations reached through a channel. Each is a real session — same
 * transcript, same replay, same model handling — so the Agent tab opens them
 * with the ordinary chat view rather than a parallel implementation.
 */
/**
 * The agent's own conversation — the one the mirror writes into.
 *
 * Created here if it does not exist yet. It is otherwise made lazily, the first
 * time something is mirrored into it, so a fresh install landing on "/" would
 * find nothing to open and fall back to whatever task session happened to be
 * most recent. That is the old behaviour, and it puts the least interesting
 * session in front of the person by default.
 */
app.get("/api/agent/main", async (_req, res) => {
  try {
    res.json({ id: await mainConversation(EXECUTOR_KIND) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/agent/sessions", async (_req, res) => {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT id, slug, name, kind FROM channels");
  const channels = reader.getRowObjectsJson() as unknown as { id: string; slug: string; name: string; kind: string }[];
  const bySlug = new Map(channels.map((c) => [c.slug, c]));

  res.json({
    agentHome: agentHome(),
    sessions: (await listAgentSessions()).map((s) => ({
      ...toApi(s),
      // Matched on the slug, so a channel deleted and recreated under the same
      // one still owns its conversations.
      channel: s.channel_slug
        ? {
            slug: s.channel_slug,
            name: bySlug.get(s.channel_slug)?.name ?? s.channel_slug,
            kind: bySlug.get(s.channel_slug)?.kind ?? null,
            present: bySlug.has(s.channel_slug),
          }
        : null,
    })),
  });
});

/**
 * A new agent conversation started from the browser.
 *
 * Not a channel: the portal's own UI is a better client than any channel could
 * be — it streams the transcript, shows tool calls and answers extension
 * dialogs — so it talks to the agent directly rather than relaying text.
 * "browser" is a reserved slug so these group together on the Agent tab.
 */
app.post("/api/agent/sessions", async (req, res) => {
  const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim() : "";
  try {
    const { session } = await resolveChannelSession({
      channelSlug: "browser",
      key: nanoid(8),
      title: title || `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      executor: EXECUTOR_KIND,
    });
    res.json(toApi(session));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- the agent's home directory ---

app.get("/api/agent/setup", async (_req, res) => {
  res.json(await identityStatus());
});

/** Run the wizard. Refuses to overwrite an existing MEMORY.md. */
app.post("/api/agent/setup", async (req, res) => {
  const body = (req.body ?? {}) as WizardInput;
  // Blank is allowed: an agent with no name is asked to choose one rather than
  // inheriting the portal's. See runWizard.
  if (typeof body.agentName !== "string") {
    return res.status(400).json({ error: "agentName must be a string (it may be empty)" });
  }
  if (typeof body.userName !== "string" || !body.userName.trim()) {
    return res.status(400).json({ error: "Who is it working for?" });
  }
  try {
    await runWizard(body);
    res.json(await identityStatus());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.put("/api/agent/files/:name", async (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await writeIdentity(req.params.name, content);
    res.json(await identityStatus());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { title, workspace } = req.body ?? {};

  /**
   * A session with nowhere to work gets its own directory.
   *
   * Handing the caller the choice meant two sessions could be pointed at one
   * folder — which the portal allowed, and which happened: two sessions were
   * found editing the same files with nothing separating them. Work from one
   * piece of work leaking into another is not a thing to leave to whoever
   * types the form.
   *
   * Named from the id rather than the title, because the id is unique and a
   * title is whatever somebody wrote. Titles collide; "notes" twice is two
   * sessions in one folder again.
   *
   * A workspace given explicitly is still honoured — pointing a session at an
   * existing checkout is the ordinary case and the whole reason the portal has
   * workspaces at all. What changes is that *not* choosing gets you isolation
   * rather than a default that collides.
   */
  const id = nanoid(12);
  if (workspace === undefined || workspace === null || workspace === "") {
    const own = path.join(WORKSPACE_ROOT, `session-${id}`);
    mkdirSync(own, { recursive: true });
    await createSession({
      id,
      title: (typeof title === "string" && title.trim()) || `session ${id}`,
      workspace: own,
      executor: EXECUTOR_KIND,
    });
    return res.json(toApi((await getSession(id))!));
  }

  if (typeof workspace !== "string") {
    return res.status(400).json({ error: "workspace must be a string, or omitted for a fresh one" });
  }
  // Keep pi inside the mounted workspace area — no escaping to the rest of the FS.
  const resolved = path.resolve(workspace);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "workspace must be inside the workspace root" });
  }
  if (!existsSync(resolved)) return res.status(400).json({ error: "workspace does not exist" });

  await createSession({
    id,
    // Default the session name to the workspace folder name.
    title: (typeof title === "string" && title.trim()) || path.basename(resolved),
    workspace: resolved,
    executor: EXECUTOR_KIND,
  });
  res.json(toApi((await getSession(id))!));
});

app.get("/api/sessions/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(toApi(session));
});

app.patch("/api/sessions/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { title, pinned } = req.body ?? {};
  if (typeof title === "string" && title.trim()) await updateSession(session.id, { title: title.trim() });
  if (typeof pinned === "boolean") await updateSession(session.id, { pinned: pinned ? 1 : 0 });
  res.json(toApi((await getSession(session.id))!));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.stop(session.id);
  await deleteSession(session.id);
  res.json({ ok: true });
});

// --- prompting ---

app.post("/api/sessions/:id/prompt", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message required" });
  }
  try {
    // Returns as soon as pi accepts the prompt. The run continues server-side
    // regardless of what this browser does next.
    await sessions.prompt(session.id, message);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** The browser answering a dialog an extension is waiting on. */
app.post("/api/sessions/:id/ui-response", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { id, value, cancelled } = req.body ?? {};
  if (typeof id !== "string") return res.status(400).json({ error: "id required" });
  const delivered = sessions.respondUi(session.id, id, { value, cancelled: Boolean(cancelled) });
  res.json({ ok: delivered, note: delivered ? undefined : "Request already resolved or expired" });
});

app.post("/api/sessions/:id/abort", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.abort(session.id);
  res.json({ ok: true });
});

// --- per-session config (the web equivalent of the TUI's slash commands) ---

/**
 * The agent's plan for this session — read-only.
 *
 * There is no endpoint to write one, deliberately. These are the agent's own
 * steps for the work in hand, not a queue you fill: routines are the thing you
 * create and schedule. The UI shows this so you can watch it work, and polls
 * it alongside everything else.
 */
app.get("/api/sessions/:id/tasks", async (req, res) => {
  res.json({ tasks: await listTasks(req.params.id) });
});

app.get("/api/sessions/:id/config", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });

  // Deliberately does not start pi. Opening a session used to boot a model
  // runtime just to draw the pills under the composer — around 600ms for
  // whichever session got there first, before anything had been asked of it.
  // The stored model and effort are what those pills need, and they are right
  // here on the row.
  if (!sessions.isRunning(session.id)) {
    const defaults = await getSettings();
    return res.json({
      live: false,
      state: {
        model: {
          id: session.model || defaults.model || "default",
          name: session.model || defaults.model || "pi's default",
          provider: session.provider || defaults.provider,
        },
        thinkingLevel: session.thinking_level || defaults.thinkingLevel,
      },
      // Unknowable without the session open, and a made-up zero reads as
      // "empty context" rather than "not measured yet".
      stats: null,
      thinking: { levels: [] },
      models: { models: [] },
    });
  }

  try {
    const client = await sessions.client(session.id);
    const [state, levels, models, stats] = await Promise.all([
      client.getState(),
      client.getThinkingLevels(),
      client.getModels(),
      client.getStats(),
    ]);
    res.json({ live: true, state, thinking: { levels }, models: { models }, stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * The model catalogue and effort levels, which do need pi running.
 *
 * Split out so the cost lands when the picker is opened rather than on every
 * session you glance at.
 */
app.get("/api/sessions/:id/models", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const client = await sessions.client(session.id);
    const [state, levels, models, stats] = await Promise.all([
      client.getState(),
      client.getThinkingLevels(),
      client.getModels(),
      client.getStats(),
    ]);
    res.json({ live: true, state, thinking: { levels }, models: { models }, stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions/:id/config", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { provider, modelId, thinkingLevel, autoCompaction, autoRetry } = req.body ?? {};
  const applied: string[] = [];
  try {
    const client = await sessions.client(session.id);
    if (typeof modelId === "string" && modelId) {
      await client.setModel(provider || (await getSettings()).provider, modelId);
      applied.push("model");
    }
    if (typeof thinkingLevel === "string" && thinkingLevel) {
      await client.setThinkingLevel(thinkingLevel);
      applied.push("thinkingLevel");
    }
    if (typeof autoCompaction === "boolean") {
      await client.setAutoCompaction(autoCompaction);
      applied.push("autoCompaction");
    }
    if (typeof autoRetry === "boolean") {
      await client.setAutoRetry(autoRetry);
      applied.push("autoRetry");
    }
    const state = await client.getState();
    // Recorded so the choice survives a restart, not just this pi process.
    // Taken from the resolved state rather than the request: pi coerces the
    // thinking level on a non-reasoning model, and storing what was asked for
    // would reapply the rejected value on every relaunch.
    //
    // Only the fields actually changed are written. Persisting all of them on
    // any change meant that adjusting the effort while pi was sitting on a
    // fallback model wrote that fallback in as the session's chosen model.
    const patch: Parameters<typeof updateSession>[1] = {};
    if (applied.includes("model")) {
      patch.provider = state.model.provider;
      patch.model = state.model.id;
    }
    if (applied.includes("thinkingLevel")) patch.thinking_level = state.thinkingLevel;
    if (Object.keys(patch).length) await updateSession(session.id, patch);

    res.json({ ok: true, applied, state });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, applied });
  }
});

app.post("/api/sessions/:id/compact", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const client = await sessions.client(session.id);
    await client.compact();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Commands available in this session: built-ins plus anything contributed by
 * installed packages. Discovered at runtime, so installing a package makes its
 * commands available immediately.
 */
app.get("/api/sessions/:id/commands", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    const client = await sessions.client(session.id);
    // Builtins first: they are the ones people reach for most.
    const [builtins, discovered] = await Promise.all([
      getBuiltinCommands(),
      client.getCommands(),
    ]);
    res.json({ commands: [...builtins, ...discovered] });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- pi packages (extensions, skills, prompts, themes) ---
app.use("/api", packagesRouter());
app.use("/api", extensionsRouter());
app.use("/api", channelsRouter());
app.use("/api", routinesRouter());
app.use("/api", skillsRouter());
app.use("/api", peopleRouter());
app.use("/api", memoryRouter());
app.use("/api", healthRouter());

// --- event stream ---

/**
 * Replay-then-tail. The client passes the last seq it saw, so reconnecting
 * after minutes or days delivers exactly what was missed and then continues
 * live — no gap, no duplicates.
 */
app.get("/api/sessions/:id/events", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });

  const since = Number(req.query.since ?? 0) || 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (row: { seq: number; type: string; payload: string; created_at?: string }) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // A malformed row is one lost event, not a dead stream. Throwing here
      // rejects inside an async handler with no catch, which takes the whole
      // connection down mid-replay and loses everything after it.
      return;
    }
    res.write(
      `id: ${row.seq}\ndata: ${JSON.stringify({
        seq: row.seq,
        type: row.type,
        payload,
        // The client cannot say how long a tool took, or when anything
        // happened, without this — and the row has carried it all along.
        at: row.created_at,
      })}\n\n`,
    );
  };

  // Replaying is now a sequence of awaits (DuckDB is async, unlike
  // better-sqlite3), so a live event can arrive mid-replay. Buffered here and
  // flushed once the replay's own cursor is settled, so nothing written
  // during the gap is silently dropped or sent out of order.
  let replaying = true;
  const buffered: { seq: number; type: string; payload: string }[] = [];
  const onEvent = (row: { seq: number; type: string; payload: string }) => {
    if (replaying) {
      buffered.push(row);
      return;
    }
    deliver(row);
  };
  let lastSent = 0;
  const deliver = (row: { seq: number; type: string; payload: string }) => {
    // Live-only events carry a negative seq: deliver them, but never let one
    // move the replay cursor, or a reconnect would skip stored history.
    if (row.seq < 0) {
      write(row);
      return;
    }
    // Guard against double-sending anything the replay already covered.
    if (row.seq <= lastSent) return;
    lastSent = row.seq;
    write(row);
  };
  sessions.on(`session:${session.id}`, onEvent);

  // A fresh load gets the end of the conversation, not the beginning. Replaying
  // from zero and stopping at the batch limit is how a long session came back
  // from a refresh showing its first few thousand events and nothing since —
  // the transcript ended mid-turn, on whatever the cap happened to land on.
  const cursor = since === 0 ? await replayStart(session.id, REPLAY_EVENTS) : since;

  // Paged to the end rather than one batch: a reconnect after a long run has
  // more to catch up on than a single query returns, and stopping early loses
  // exactly the part it was reconnecting for.
  lastSent = cursor;
  for (;;) {
    const batch = await eventsSince(session.id, lastSent);
    if (!batch.length) break;
    for (const row of batch) {
      write(row);
      lastSent = row.seq;
    }
    if (batch.length < 5000) break;
  }
  res.write(`event: caught-up\ndata: ${JSON.stringify({ seq: lastSent })}\n\n`);

  // Now flush whatever arrived while replaying, in order, through the same
  // dedup/cursor logic live events get from here on.
  replaying = false;
  for (const row of buffered) deliver(row);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sessions.off(`session:${session.id}`, onEvent);
  });
});

// --- static web UI ---

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

// On PATH via the image, but a volume that predates it has no such directory —
// docker only seeds a volume that is empty, so an existing deploy would carry a
// PATH entry pointing at nothing.
mkdirSync(BIN_DIR, { recursive: true });

// One-time, idempotent: pulls any identity content already on disk into the
// graph before the first session can start, so existing SELF_CONCEPT/
// INNER_LIFE work survives the migration to graph-backed identity.
await migrateIdentityFromDisk();
// After the migration, because it rewrites what that just seeded. See
// stopIdentityNamingFiles: an agent seeded before this carries content that
// tells it to open files which do not exist.
/**
 * Catch up any memory written while no embedding server was reachable.
 *
 * Not awaited: this is background repair, and the portal must come up whether
 * or not the model server is there. Batched with a pause between rounds so a
 * long backlog does not saturate a CPU-only embedder that the live path also
 * needs.
 */
if (process.env.EMBEDDING_BASE_URL) {
  void (async () => {
    const waiting = await unembeddedCount().catch(() => 0);
    if (!waiting) return;
    console.log(`[portal] ${waiting} memory node(s) have no embedding yet — backfilling in the background`);
    let done = 0;
    for (;;) {
      const n = await backfillEmbeddings().catch(() => 0);
      if (!n) break;
      done += n;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (done) console.log(`[portal] embedded ${done} memory node(s); semantic recall now covers them`);
  })();
}

// The mirrors used to sit in agentHome(), which is every agent session's own
// working directory — so `ls .` showed them and the learning loop read them
// instead of using its tools. See relocateMirrors.
const relocated = relocateMirrors();
if (relocated > 0) {
  console.log(`[portal] moved ${relocated} identity mirror(s) out of the agent's working directory`);
}

/**
 * Trim the event log at boot as well as in cleanup.
 *
 * routine_cleanup only runs when the Dream Cycle reaches PHASE 7, which needs
 * ten minutes of quiet and a three-hour gap — precisely the conditions a
 * runaway loop prevents. The case that filled a database to 2.2 GB was
 * therefore also the case that would never have trimmed it.
 */
/**
 * Trim on a timer, not only at boot.
 *
 * At boot alone this bounds a portal that restarts and nothing else. A portal
 * left running is precisely the case that grows: the learning loop writes
 * continuously, and `routine_cleanup` — the other caller — only runs when the
 * Dream Cycle reaches PHASE 7, which needs ten minutes of quiet and a
 * three-hour gap that a busy loop never leaves.
 *
 * Three databases were lost to this before the shape was clear. Each had grown
 * unbounded (2.2 GB, then 459 MB, then 841 MB) and then failed to open at all,
 * with an IO error reading past its own end. The event log is a display and
 * audit record — pi keeps the conversation, the graph keeps what was learned —
 * so trimming costs history nobody was reading and saves the file.
 *
 * Every twenty minutes: often enough that no plausible burst reaches the size
 * that breaks things, rare enough to be invisible.
 */
const TRIM_INTERVAL_MS = 20 * 60_000;
setInterval(() => {
  void trimEventLog()
    .then((n) => {
      if (n > 0) console.log(`[portal] trimmed ${n} old event(s) from the log`);
    })
    .catch(() => {});
}, TRIM_INTERVAL_MS).unref();

void trimEventLog()
  .then((n) => {
    if (n > 0) console.log(`[portal] trimmed ${n} old event(s) from the log`);
  })
  .catch(() => {});

// An agent named after the portal has not been named at all — see
// inviteNameChoice.
if (await inviteNameChoice()) {
  console.log("[portal] the agent was named after the portal; it has been asked to choose its own");
}

/**
 * A person editing the readable mirror expects that to mean something.
 *
 * Checked at boot rather than continuously: an identity document is not edited
 * often, and watching five files for changes is machinery earning nothing most
 * of the time. Restart to apply is a reasonable contract for a file you edit by
 * hand once a month.
 */
const adopted = await adoptDiskEdits();
if (adopted.length) {
  console.log(`[portal] adopted disk edits to ${adopted.join(", ")}`);
}

const renamed = await stopIdentityNamingFiles();
if (renamed > 0) console.log(`[portal] repaired ${renamed} identity document(s) that described themselves as files`);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`phenoixclaw listening on :${PORT}`);
  console.log(`  local bin: ${BIN_DIR}`);
  console.log(`  executor: ${EXECUTOR_KIND}`);
  console.log(`  workspaces: ${WORKSPACE_ROOT}`);
  console.log(`  auth:     ${authEnabled ? "password" : "DISABLED"}`);

  /**
   * Say plainly when a dependency is missing, at the one moment somebody is
   * looking at the output.
   *
   * Both of these degrade silently by design — a failed embedding falls back to
   * keyword search, a missing local model skips extraction — and that is right
   * for a request in flight and wrong for a deployment. Conversation harvesting
   * ran for a full day writing no entities at all because LLAMA_BASE_URL was
   * never set, and nothing anywhere said so: the feature looked like it worked
   * and the graph simply stayed empty.
   */
  /**
   * The container executor's guard gap, said once where somebody will see it.
   *
   * Not a warning about configuration that might be wrong — this one is a
   * capability the deployment does not have, and finding out when a colleague's
   * message fails is finding out too late.
   */
  if (EXECUTOR_KIND === "container") {
    console.warn("  limited:  EXECUTOR=container registers no guard, so it runs task sessions only.");
    console.warn("            Channel conversations and autonomous routines are refused — they need the");
    console.warn("            roles check and the constitution's allowlist. Set EXECUTOR=host for those.");
  }

  for (const [env, effect] of [
    ["LLAMA_BASE_URL", "no fact extraction from conversations or pages"],
    ["EMBEDDING_BASE_URL", "memory search is keyword-only, no semantic recall"],
    ["SEARXNG_URL", "web search unavailable"],
  ] as const) {
    if (!process.env[env]) console.warn(`  degraded: ${env} unset — ${effect}`);
  }

  // Enabled channels come up with the server, so a restart does not silently
  // leave the agent unreachable.
  // Schedules resume with the server; a routine due while it was down does not
  // fire retroactively, it simply waits for its next slot.
  routineSupervisor.start();

  channelSupervisor
    .sync()
    .then(() => console.log(`  channels: ${channelSupervisor.summary()}`))
    .catch((e) => console.error(`[portal] channel startup failed: ${e.message}`));
});

/**
 * Exiting without cutting a checkpoint in half.
 *
 * Closing the databases means checkpointing them, and a checkpoint's duration
 * is a function of the file's size — portal.duckdb reaches hundreds of
 * megabytes on a busy agent and DuckDB never shrinks a file, so it stays there.
 * Interrupt one partway and the block metadata points at blocks that were never
 * written; the database then cannot be opened at all, not even read-only. There
 * is no repair for that, only the quarantine in graph.ts's attachDuckDB.
 *
 * So nothing may call process.exit while a close is in flight. The watchdog
 * that gives up on lingering HTTP connections must not become the thing that
 * kills the write — and a second Ctrl-C, which is exactly what an impatient
 * operator does when a shutdown seems slow, must not either.
 */
let closingDatabases = false;
let shuttingDown = false;

function exitWhenSafe(code = 0) {
  if (!closingDatabases) process.exit(code);
  // Re-arm rather than exit. Unbounded on purpose: a checkpoint that has not
  // finished is not a reason to corrupt it, and closeDb has its own failure
  // path if the database is truly stuck.
  setTimeout(() => exitWhenSafe(code), 250).unref();
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    console.log(`${signal} received — already shutting down; the database is still being written.`);
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received — stopping running sessions`);
  routineSupervisor.stop();
  await channelSupervisor.shutdown();
  await sessions.shutdown();
  // Both databases are single-writer, and the lock outlives the signal unless
  // it is handed back. A restart inside that window could not open them at all
  // — see openDuckDB's lock wait, which is the other half of this.
  closingDatabases = true;
  try {
    await Promise.all([closeDb().catch(() => {}), closeGraph().catch(() => {})]);
  } finally {
    closingDatabases = false;
  }
  server.close(() => exitWhenSafe(0));
  // An open SSE stream keeps server.close from ever calling back, so this is
  // the real exit path most of the time. It runs after the databases are shut,
  // and exitWhenSafe is the guard for the case where that is not yet true.
  setTimeout(() => exitWhenSafe(0), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
