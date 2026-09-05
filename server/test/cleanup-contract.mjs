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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
