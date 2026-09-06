/**
 * Opening a database that did not survive the last shutdown.
 *
 * Two distinct failures, both of which have actually happened here:
 *
 *   - a write-ahead log that cannot be replayed, from an ALTER TABLE left in
 *     the WAL against a table with now() defaults;
 *   - the main file's own checkpoint metadata, from a checkpoint interrupted
 *     partway through — "Failed to load metadata pointer". DuckDB will not
 *     open such a file at all, not even READ_ONLY, so there is nothing to
 *     salvage in place.
 *
 * Both must leave the portal able to start, and must move the file aside
 * rather than delete it. A portal that cannot boot needs someone on the host;
 * a portal that silently discarded the evidence is worse.
 *
 *     npm run test:recovery
 */
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { openDuckDB } = await import(path.join(here, "..", "dist", "graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const dir = mkdtempSync(path.join(tmpdir(), "recovery-"));

// A file that is not a DuckDB database at all fails the same way a truncated
// one does: the header cannot be read. It must not be quarantined — that is a
// path pointing at the wrong file, and renaming someone's data aside because
// we misread it is the one outcome worse than refusing.
{
  const notADb = path.join(dir, "notes.txt");
  writeFileSync(notADb, "this is not a database");
  let threw = false;
  try { await openDuckDB(notADb); } catch { threw = true; }
  ok("a file that is not a database is refused, not renamed", threw);
  ok("and it is left exactly where it was", readFileSync(notADb, "utf8") === "this is not a database");
}

// A real database opens, and opening it twice in a row is the ordinary case.
{
  const file = path.join(dir, "fine.duckdb");
  const a = await openDuckDB(file);
  const c = await a.connect();
  await c.run("CREATE TABLE t (x INTEGER)");
  await c.run("INSERT INTO t VALUES (1)");
  await c.run("CHECKPOINT");
  c.closeSync(); a.closeSync();

  const b = await openDuckDB(file);
  const c2 = await b.connect();
  const r = await c2.runAndReadAll("SELECT count(*) AS n FROM t");
  ok("a healthy database reopens with its rows", r.getRowObjectsJson()[0].n === 1n || Number(r.getRowObjectsJson()[0].n) === 1);
  ok("and is not quarantined", readdirSync(dir).filter((f) => f.startsWith("fine.duckdb.corrupt-")).length === 0);
  c2.closeSync(); b.closeSync();
}

// The real thing: a file whose checkpoint metadata is damaged. Corrupted by
// overwriting the block region while leaving the header intact, which is the
// shape an interrupted checkpoint leaves behind.
{
  const file = path.join(dir, "broken.duckdb");
  const a = await openDuckDB(file);
  const c = await a.connect();
  await c.run("CREATE TABLE t (x INTEGER)");
  for (let i = 0; i < 500; i++) await c.run(`INSERT INTO t VALUES (${i})`);
  await c.run("CHECKPOINT");
  c.closeSync(); a.closeSync();

  const { open, write, close } = await import("node:fs/promises").then((m) => ({
    open: m.open, write: null, close: null,
  }));
  const handle = await open(file, "r+");
  const size = (await handle.stat()).size;
  // Past the three header blocks, so the file still looks like a database and
  // fails where a truncated checkpoint fails: loading the metadata.
  await handle.write(Buffer.alloc(Math.min(64 * 1024, size - 12288), 0), 0, undefined, 12288);
  await handle.close();

  let opened = false;
  try {
    const b = await openDuckDB(file);
    const c2 = await b.connect();
    await c2.run("CREATE TABLE fresh (x INTEGER)");
    opened = true;
    c2.closeSync(); b.closeSync();
  } catch (e) {
    console.log("      (open still threw: " + String(e.message).split("\n")[0] + ")");
  }

  const quarantined = readdirSync(dir).filter((f) => /^broken\.duckdb\.corrupt-\d+$/.test(f));
  ok("a damaged database is quarantined rather than crashing the boot", quarantined.length === 1);
  ok("and the portal comes up on a fresh, usable file", opened && existsSync(file));
  ok("nothing is deleted — the original is still on disk",
     quarantined.length === 1 && existsSync(path.join(dir, quarantined[0])));
}

// --- the crash handlers must be registered before anything can throw --------
// The first version sat beside the SIGTERM handlers at the bottom of the file,
// after several top-level awaits — so a rejection during startup, which is
// exactly when a damaged database announces itself, happened before there was
// anything to catch it.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const handler = src.indexOf('process.on("unhandledRejection"');
  ok("the process handlers exist", handler > 0);

  const before = src.slice(0, handler);
  // Comments and imports may precede them; an executed await may not.
  const executable = before.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^import[\s\S]*?;$/gm, "");
  ok("and nothing is awaited before them", !/\bawait\b/.test(executable));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
