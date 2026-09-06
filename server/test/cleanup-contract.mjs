/**
 * `routine_cleanup`'s contract — what age-based pruning may and may not delete.
 *
 * This one exists because the first version deleted the user's routines. The
 * supervisor writes `last_run`/`last_status`/`next_run` on every run but never
 * `updated_at`, so a routine that had fired daily for a month still looked
 * untouched since the day it was seeded. Thirty days after a first boot the
 * Dream Cycle reached PHASE 7, called this, and removed the learning loop, the
 * self-update routine, and itself — unattended, on the agent's own initiative,
 * with nobody watching. Pinned sessions went the same way, and every deleted
 * session left its events and tasks behind.
 *
 * It also pins the ALTER TABLE behaviour the column migrations depend on —
 * see the bottom of the file. @duckdb/node-api's pin is documented as free to
 * move, and that is exactly the kind of change that would break it silently.
 *
 * Needs a database, so it runs against a throwaway DATA_DIR:
 *
 *     npm run test:cleanup
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { getDb, pruneOldRecords, deleteSession } = await import(
  path.join(here, "..", "dist", "db.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const conn = await getDb();
const count = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson().length;
const slugs = async () =>
  (await conn.runAndReadAll("SELECT slug FROM routines ORDER BY slug")).getRowObjectsJson().map((r) => r.slug);

// Age everything past any plausible cutoff, and give one routine a run today —
// the case the original bug got wrong.
await conn.run("UPDATE routines SET updated_at = now() - INTERVAL 40 DAY");
await conn.run("UPDATE routines SET last_run = now()::TEXT, last_status = 'ok' WHERE slug = 'learning-loop'");

for (const [id, pinned] of [["pinned", 1], ["stale", 0]]) {
  await conn.run(
    `INSERT INTO sessions (id, title, workspace, executor, pinned) VALUES ('${id}', 't', '/w', 'host', ${pinned})`,
  );
  await conn.run(`INSERT INTO events (session_id, type, payload) VALUES ('${id}', 'portal_prompt', '{}')`);
  await conn.run(`INSERT INTO tasks (session_id, seq, description) VALUES ('${id}', 0, 'a step')`);
  await conn.run(`INSERT INTO notes (session_id, text) VALUES ('${id}', 'a note')`);
  await conn.run(
    `INSERT INTO grants (id, session_id, tool, subject, expires_at)
     VALUES ('g-${id}', '${id}', 'bash', 'ls', '2099-01-01')`,
  );
}
// The session a routine works in. Stale, but its routine still exists.
await conn.run(
  `INSERT INTO sessions (id, title, workspace, executor, kind, routine_slug)
   VALUES ('owned', 'loop', '/w', 'host', 'routine', 'learning-loop')`,
);
await conn.run("UPDATE sessions SET updated_at = now() - INTERVAL 40 DAY");

const seeded = await slugs();
const result = await pruneOldRecords(30);

ok("a routine that ran today is not deleted", (await slugs()).includes("learning-loop"));
ok("the routine running the cleanup is not deleted", (await slugs()).includes("self-reflection"));
ok("a routine seeded disabled and never run is not deleted", (await slugs()).includes("self-update"));
ok("no routine is aged out at all", JSON.stringify(await slugs()) === JSON.stringify(seeded));
ok("nothing claims to have pruned routines", result.routines === undefined);

ok("a pinned session survives however old", (await count("SELECT 1 FROM sessions WHERE id = 'pinned'")) === 1);
ok("a routine's own session survives", (await count("SELECT 1 FROM sessions WHERE id = 'owned'")) === 1);
ok("an unpinned stale session is removed", (await count("SELECT 1 FROM sessions WHERE id = 'stale'")) === 0);
ok("and is the only one counted", result.sessions === 1);

// Every table that hangs off a session, since there are no FOREIGN KEYs to do it.
for (const table of ["events", "tasks", "notes", "grants"]) {
  ok(
    `pruning leaves no orphaned ${table}`,
    (await count(
      `SELECT 1 FROM ${table} x WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = x.session_id)`,
    )) === 0,
  );
  ok(`a surviving session keeps its ${table}`, (await count(`SELECT 1 FROM ${table} WHERE session_id = 'pinned'`)) === 1);
}

// The same cascade on the explicit path, which only ever cleared `events`.
await deleteSession("pinned");
ok("deleteSession removes the session", (await count("SELECT 1 FROM sessions WHERE id = 'pinned'")) === 0);
for (const table of ["events", "tasks", "notes", "grants"]) {
  ok(`deleteSession cascades to ${table}`, (await count(`SELECT 1 FROM ${table} WHERE session_id = 'pinned'`)) === 0);
}

// A cutoff short enough to catch everything still must not touch a routine.
await conn.run("UPDATE routines SET updated_at = now() - INTERVAL 400 DAY");
await pruneOldRecords(1);
ok("a one-day cutoff still spares every routine", JSON.stringify(await slugs()) === JSON.stringify(seeded));

// --- what ALTER TABLE will and will not accept -------------------------------
// DuckDB rejects a constraint on ALTER TABLE ADD COLUMN, and the failure lands
// at startup as an uncaught rejection before the server ever listens. Every
// column migration carried `NOT NULL DEFAULT x` and none had ever fired,
// because each column had only been added to a table being created fresh — the
// first database old enough to need one would have failed to open. addColumn()
// drops the constraint and backfills instead; these assertions are what tell us
// if a DuckDB upgrade makes that unnecessary, or changes it again.
await conn.run("CREATE TABLE alter_probe (id TEXT)");
await conn.run("INSERT INTO alter_probe VALUES ('a')");

let rejected = false;
try {
  await conn.run("ALTER TABLE alter_probe ADD COLUMN n INTEGER NOT NULL DEFAULT 0");
} catch (e) {
  rejected = /constraint/i.test(String(e?.message ?? e));
}
ok("DuckDB still rejects ADD COLUMN with a constraint", rejected);

await conn.run("ALTER TABLE alter_probe ADD COLUMN m INTEGER DEFAULT 0");
ok("without the constraint it is accepted",
   (await conn.runAndReadAll("SELECT m FROM alter_probe")).getRowObjectsJson()[0].m === 0);

// The backfill the helper does, so an existing row is never left null.
await conn.run("ALTER TABLE alter_probe ADD COLUMN k INTEGER");
await conn.run("UPDATE alter_probe SET k = 0 WHERE k IS NULL");
ok("a backfilled column has no nulls",
   (await conn.runAndReadAll("SELECT 1 FROM alter_probe WHERE k IS NULL")).getRowObjectsJson().length === 0);

// And the column the taint actually needs is present and defaulted.
ok("sessions.tainted exists and defaults to 0",
   (await conn.runAndReadAll(
     "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'tainted'",
   )).getRowObjectsJson()[0].n == 1);

// --- the event log is bounded --------------------------------------------
// pruneOldRecords removes stale sessions and their events with them, which is
// no help against the case that actually happened: one live session growing
// without bound. 774 loop iterations left 186,000 events and a 2.2 GB database
// that would not open at all.
{
  const { trimEventLog } = await import(path.join(here, "..", "dist", "db.js"));
  await conn.run(`INSERT INTO sessions (id, title, workspace, executor) VALUES ('loud', 'l', '/w', 'host')`);
  await conn.run(`INSERT INTO sessions (id, title, workspace, executor) VALUES ('quiet', 'q', '/w', 'host')`);
  for (let i = 0; i < 120; i++) {
    await conn.run(`INSERT INTO events (session_id, type, payload) VALUES ('loud', 'message_update', '{}')`);
  }
  for (let i = 0; i < 10; i++) {
    await conn.run(`INSERT INTO events (session_id, type, payload) VALUES ('quiet', 'message_update', '{}')`);
  }

  const removed = await trimEventLog(50);
  ok("a runaway session is trimmed", removed === 70);
  ok("down to the cap", (await count("SELECT 1 FROM events WHERE session_id = 'loud'")) === 50);
  ok("a quiet session is untouched", (await count("SELECT 1 FROM events WHERE session_id = 'quiet'")) === 10);

  // Counted per session, because seq is one sequence shared by every session —
  // a global cap is "whatever this conversation did while the portal was busy".
  ok("trimming again is a no-op", (await trimEventLog(50)) === 0);

  // DuckDB does not shrink a file on DELETE — pages are freed for reuse and the
  // file stays as large as it ever was. Three databases grew past the point of
  // opening because rows were trimmed and the space never reclaimed.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  ok("trimming checkpoints, or the file never shrinks",
     /if \(removed\) \{[\s\S]{0,1600}await checkpoint\(conn\);/.test(src));

  /**
   * And rebuilds the index it just churned.
   *
   * DuckDB's ART index does not tidy itself after a large delete, and the next
   * insert into it can fail with "node without metadata in
   * ARTOperator::Insert" — an internal error, not a caller mistake. It killed
   * the portal once on the very first event append after a trim, taking a
   * working session with it.
   */
  ok("and rebuilds the index the deletes churned",
     /DROP INDEX IF EXISTS idx_events_session/.test(src) &&
     /CREATE INDEX idx_events_session/.test(src));

  /**
   * A session must not report itself finished between the steps of its plan.
   *
   * Three separate places settled it: the agent_end handler, the fall-through
   * in afterTurn when workPlan declined because one was already in flight, and
   * prompt()'s slash-command heuristic — which sees an idle client because a
   * step's turn is deliberately ended the moment its section is written. The
   * UI showed a finished session that then started moving again, and the e2e
   * harness gave up at the first step every time.
   */
  const mgr = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok("afterTurn leaves the status alone while a plan is being driven",
     /private async afterTurn[\s\S]{0,900}this\.working\.has\(sessionId\)\) return;/.test(mgr));
  /**
   * Stronger than the exclusion it replaced.
   *
   * The heuristic used to run for every prompt and skip only while a plan was
   * being driven. It now runs for nothing but a slash command, which is the
   * only thing it was ever for — a command completes inside prompt() without
   * an agent turn, so nothing else would clear its status. Everything else,
   * plan steps included, is settled by the turn actually ending.
   *
   * The exclusion was not enough on its own: a *queued* message resolves the
   * moment it is accepted, and the client reads idle in that instant because
   * the next turn has not begun. A steered follow-up settled the session while
   * the previous answer was still streaming.
   */
  ok("and the prompt heuristic settles nothing but a slash command",
     /if \(!isCommand\) return;\s*\n\s*await updateSession\(sessionId, \{ status: "idle" \}\);/.test(mgr));

  /**
   * The after-turn check must read a turn that has finished being written
   * down, not merely one that has finished. `record` chains its appends so
   * ordering survives, and `agent_end` arrives before the chain drains — so a
   * session that had just run `echo $((17*23))` and answered 391 was told it
   * had done the arithmetic in its head.
   */
  ok("the after-turn check waits for the log to catch up",
     /await this\.appends\.get\(sessionId\)\?\.catch[\s\S]{0,400}recentToolCalls/.test(mgr));

  // A rejected promise in any `void this.something()` path used to kill the
  // process, which ends every running session at once — the opposite of a run
  // belonging to the server.
  const idxSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  ok("a background failure does not take the portal down",
     /process\.on\("unhandledRejection"/.test(idxSrc) && /staying up/.test(idxSrc));

  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  ok("and it runs on a timer, not only at boot", /setInterval\([\s\S]{0,200}trimEventLog/.test(idx));

  // The newest are what a reader scrolls back through, so they are what stays.
  const newest = (await conn.runAndReadAll(
    "SELECT max(seq) AS m FROM events WHERE session_id = 'loud'",
  )).getRowObjectsJson()[0];
  const oldest = (await conn.runAndReadAll(
    "SELECT min(seq) AS m FROM events WHERE session_id = 'loud'",
  )).getRowObjectsJson()[0];
  ok("and it is the newest that survive", Number(newest.m) - Number(oldest.m) === 49);
}

// --- the settings endpoint writes three fields, not the whole table -------
// `settings` also holds the Dream Cycle's high-water mark and the default
// report destination. Iterating the request body meant a PUT of
// {"self_reflection_seq":"0"} would send the next cycle back over the entire
// event history.
{
  const { setSettings, getStoredSettings, setReflectionSeq, getReflectionSeq } =
    await import(path.join(here, "..", "dist", "db.js"));

  await setReflectionSeq(12345);
  await setSettings({ provider: "local-llama", model: "some-model", thinkingLevel: "high" });
  ok("the three real fields are written",
     (await getStoredSettings()).provider === "local-llama");

  await setSettings({ self_reflection_seq: "0", report_channel: "attacker" });
  ok("the dream cycle's watermark is untouched", (await getReflectionSeq()) === 12345);
  ok("and an unknown key is not stored",
     (await getStoredSettings()).report_channel === undefined);
  ok("while the real fields still work",
     (await getStoredSettings()).model === "some-model");

  // Clearing is still possible — an empty value hands a field back to pi's
  // own default rather than pinning it forever.
  await setSettings({ model: "" });
  ok("an empty value clears rather than storing nothing",
     (await getStoredSettings()).model === undefined);
}

// --- closing must wait for queued writes ----------------------------------
// closeSync is not a statement, so the serialising proxy passed it straight
// through while writes were still queued — the file was closed mid-write and
// left shorter than its own metadata claimed:
//
//   IO Error: Could not read enough bytes from file "data/portal.duckdb":
//   attempted to read 262144 bytes from location 485240832
//
// on a 459 MB file. Two databases were lost before the cause was clear, and
// both times it looked like corruption rather than a bug in the shutdown path.
{
  const { serialiseStatements } = await import(path.join(here, "..", "dist", "graph.js"));

  const order = [];
  let closed = false;
  const fake = {
    async run(sql) {
      await new Promise((r) => setTimeout(r, 20));
      order.push(sql);
    },
    async runAndReadAll() {
      return { getRowObjectsJson: () => [] };
    },
    closeSync() {
      closed = true;
      order.push("CLOSE");
    },
  };

  const wrapped = serialiseStatements(fake);
  ok("the proxy exposes a draining close", typeof wrapped.closeAfterPending === "function");

  // Fire writes without awaiting, exactly as the portal's fire-and-forget
  // paths do, then close.
  void wrapped.run("first");
  void wrapped.run("second");
  void wrapped.run("third");
  await wrapped.closeAfterPending();

  ok("every queued write ran", order.filter((x) => x !== "CLOSE").length === 3);
  ok("and the close came last", order[order.length - 1] === "CLOSE");
  ok("in the order they were issued",
     JSON.stringify(order) === JSON.stringify(["first", "second", "third", "CLOSE"]));
  ok("the connection is actually closed", closed === true);
}

// --- and a failed statement must not wedge the queue ----------------------
{
  const { serialiseStatements } = await import(path.join(here, "..", "dist", "graph.js"));
  const done = [];
  const wrapped = serialiseStatements({
    async run(sql) {
      if (sql === "bad") throw new Error("nope");
      done.push(sql);
    },
    async runAndReadAll() {
      return { getRowObjectsJson: () => [] };
    },
    closeSync() {},
  });

  await wrapped.run("bad").catch(() => {});
  await wrapped.run("after");
  ok("one failed statement does not block the next", done.includes("after"));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
