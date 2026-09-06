import {
  ARRAY,
  arrayValue,
  DuckDBInstance,
  FLOAT,
  listValue,
  TIMESTAMPTZ,
  timestampTZValue,
  type DuckDBConnection,
} from "@duckdb/node-api";
// llm.ts imports nothing from here, so this is not a cycle. It is the same
// local model the extraction and pruning passes use — see refineRelations.
import { complete } from "./llm.js";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

/**
 * The knowledge graph — nodes/edges in DuckDB, replacing the NetworkX+JSON
 * store Sisyphean used. Same semantics (typed nodes, confidence/corroboration,
 * anchor protection, keyword search weighted by confidence), a real database
 * underneath instead of a hand-rolled JSON file with no indexing or schema.
 *
 * Traversal is plain SQL — a join for one hop, a recursive CTE for n. It was
 * DuckPGQ, which crashed the process from a background thread on any graph
 * bigger than a few nodes; see the comment above neighbours()/traverse(). With
 * it went the only reason @duckdb/node-api was pinned to 1.4.4, so that pin is
 * now free to move.
 */

export type NodeType =
  | "anchor"
  | "user"
  | "project"
  | "concept"
  | "fact"
  | "skill"
  // Below: BirdClaw's memory extras, folded into this same graph rather than
  // separate stores — a turn-history entry, a memoized tool result, cleaned
  // web content by URL, and a per-project log entry, respectively. See the
  // `scoped_to` edge and scopedSearch/scopedRecall below for how these stay
  // fenced to the project they came from instead of bleeding across projects.
  | "episode"
  | "tool_cache"
  | "page"
  | "workspace_note";

export interface NodeRow {
  id: string;
  type: string;
  name: string;
  summary: string;
  confidence: number;
  observations: number;
  created_at: string;
  last_seen: string;
  /** Sub-typing for `user` nodes (facts/preferences/interests/behaviors) — optional, unused by other types. */
  category?: string | null;
  /** TTL for `tool_cache`/`page` nodes — null means "doesn't expire." */
  expires_at?: string | null;
  /** Where this came from — a tool name, a URL, a conversation, `primary-user`. */
  sources?: string[] | null;
}

/**
 * A dedicated CPU-only embedding server (nomic-embed-text-v1.5, 768 dims) —
 * kept separate from the chat model's llama-server, which runs without
 * `--embeddings` and has no GPU memory budget to spare for it.
 * `embedText()` degrades gracefully to `undefined` on any failure — search
 * falls back to keyword-only (see `searchNodesSemantic`) rather than erroring.
 */
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:8101/v1/embeddings";
const EMBEDDING_DIM = 768;

async function embedText(text: string): Promise<number[] | undefined> {
  try {
    const res = await fetch(EMBEDDING_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = body.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length === EMBEDDING_DIM ? vec : undefined;
  } catch {
    return undefined;
  }
}

export interface NeighborRow extends NodeRow {
  relation: string;
  direction: "out" | "in";
}

const DATA_DIR = process.env.DATA_DIR || "./data";

/** The FTS index isn't incremental — rebuilt lazily, only when something changed since the last search. */
let dirty = true;

let connPromise: Promise<DuckDBConnection> | null = null;

async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      confidence DOUBLE NOT NULL DEFAULT 0.5,
      observations INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      last_seen TIMESTAMP NOT NULL DEFAULT now(),
      embedding FLOAT[${EMBEDDING_DIM}]
    )
  `);
  /**
   * No FOREIGN KEY on source_id/target_id, deliberately.
   *
   * DuckDB implements UPDATE on a table that something references as a delete
   * followed by an insert, and the delete half trips its own constraint. The
   * effect is that a node becomes frozen the moment it gains its first edge:
   *
   *     upsertNode("Alpha", ...)          -> ok
   *     upsertEdge("Alpha", "x", "Beta")  -> ok
   *     upsertNode("Alpha", ...)          -> Constraint Error
   *
   * Which is the opposite of what this graph is for. Corroboration — the rule
   * that re-observing something nudges its confidence up rather than
   * overwriting it — only means anything on a node you can write to twice, and
   * the nodes that matter most are exactly the ones with relations: a plan the
   * loop revises each iteration, an identity anchor, a fact that turned out to
   * connect to another.
   *
   * Referential integrity is kept in code instead: `deleteNodesWhere` already
   * clears a node's edges before the node itself, which is the only place
   * either table is deleted from. A dangling edge would cost a join that
   * matches nothing; a frozen node costs the whole feature.
   *
   * Nothing else depended on the constraint: traversal is plain SQL now, and
   * a join does not consult a foreign key.
   */
  await conn.run(`
    CREATE TABLE IF NOT EXISTS edges (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight DOUBLE NOT NULL DEFAULT 1.0
    )
  `);

  // An existing database still carries the constraint, and DuckDB has no
  // usable ALTER TABLE ... DROP CONSTRAINT for it, so the table is rebuilt.
  // Any leftover property graph is dropped first, since it is defined over
  // `edges` and would otherwise hold a reference to the table being replaced.
  const constraints = await conn.runAndReadAll(
    "SELECT constraint_type FROM duckdb_constraints() WHERE table_name = 'edges'",
  );
  const hasForeignKey = constraints
    .getRowObjectsJson()
    .some((r: any) => String(r.constraint_type).toUpperCase() === "FOREIGN KEY");
  if (hasForeignKey) {
    try {
      await conn.run("LOAD duckpgq");
      await conn.run("DROP PROPERTY GRAPH IF EXISTS knowledge");
    } catch {
      // The extension is no longer required, so its absence is expected. If a
      // stale property graph does block the rebuild below, the error from that
      // statement says so plainly.
    }
    await conn.run(`
      CREATE TABLE edges_rebuilt (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight DOUBLE NOT NULL DEFAULT 1.0
      )
    `);
    await conn.run("INSERT INTO edges_rebuilt SELECT source_id, target_id, relation, weight FROM edges");
    await conn.run("DROP TABLE edges");
    await conn.run("ALTER TABLE edges_rebuilt RENAME TO edges");
    console.log("[graph] rebuilt `edges` without its foreign keys — see the comment in ensureSchema");
  }
  // CREATE TABLE IF NOT EXISTS is a no-op against an existing database, so a
  // column added after nodes already existed on disk needs its own migration.
  const columns = await conn.runAndReadAll("SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'");
  const names = new Set(columns.getRowObjectsJson().map((r: any) => r.column_name as string));
  if (!names.has("embedding")) {
    await conn.run(`ALTER TABLE nodes ADD COLUMN embedding FLOAT[${EMBEDDING_DIM}]`);
  }
  // category: sub-typing for `user` nodes (facts/preferences/interests/behaviors).
  // expires_at: TTL for `tool_cache`/`page` nodes — null means "doesn't expire."
  /**
   * Where each belief came from.
   *
   * Under "verify, don't recall" this is the foundation, not bookkeeping: a
   * claim whose source was not kept can only be trusted, never re-checked, and
   * a wrong one can only be deleted rather than corrected at its origin. It
   * also separates what the person you work for told you from what a web page
   * said, which the guard's taint model already treats as different in kind and
   * the graph did not.
   *
   * A list rather than one value, unioned on upsert — corroboration is the
   * whole point of the confidence rule, and two sources agreeing is worth more
   * than one asserting twice.
   */
  if (!names.has("sources")) {
    await conn.run("ALTER TABLE nodes ADD COLUMN sources TEXT[]");
  }
  if (!names.has("category")) {
    await conn.run("ALTER TABLE nodes ADD COLUMN category TEXT");
  }
  if (!names.has("expires_at")) {
    // TIMESTAMPTZ, not TIMESTAMP: this column is compared against now() for
    // expiry, and now() is a timezone-aware instant — a naive TIMESTAMP
    // written from a JS Date would be compared against now() as if it were
    // wall-clock time in DuckDB's session timezone, which is wrong by
    // however far that timezone sits from UTC.
    await conn.run("ALTER TABLE nodes ADD COLUMN expires_at TIMESTAMPTZ");
  } else {
    // A database that already added this column under an earlier build (as
    // plain TIMESTAMP, before the timezone bug above was found) needs the
    // type itself corrected, not just added — column existence alone isn't
    // enough to tell the two apart.
    const type = await conn.runAndReadAll(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'expires_at'",
    );
    const dataType = (type.getRowObjectsJson()[0] as any)?.data_type as string | undefined;
    if (dataType && dataType !== "TIMESTAMP WITH TIME ZONE") {
      await conn.run("ALTER TABLE nodes ALTER COLUMN expires_at SET DATA TYPE TIMESTAMPTZ");
    }
  }

  await conn.run("INSTALL fts");
  await conn.run("LOAD fts");
  // DuckPGQ is deliberately not installed or loaded any more — see the comment
  // above neighbours()/traverse() for what it was doing and why it had to go.
  // A database created by an earlier build still has a `knowledge` property
  // graph in its catalogue; it is inert without the extension, and cleaning it
  // up is best-effort rather than a reason to fail startup.
}

/**
 * Open a DuckDB file, surviving a write-ahead log that cannot be replayed.
 *
 * `ALTER TABLE ... ADD COLUMN` re-binds every existing column default when it
 * is replayed, and both of this app's tables have `now()` defaults. During WAL
 * replay there is no default database bound, so the bind hits an internal
 * assertion and *the database will not open at all* — not a degraded start, a
 * dead process on every boot from then on. Any kill between a migration and
 * the next checkpoint gets you there: a `docker stop` that hits its timeout,
 * an OOM, a crash on the very tick that follows a schema change.
 *
 * Two halves, because one is not enough:
 *
 * - `checkpoint()` after the migrations, below, so the ALTERs land in the main
 *   file and there is nothing of that shape left in the WAL to replay. That
 *   prevents it happening again.
 * - This, which recovers a database already in that state. Renaming the WAL
 *   aside loses whatever had not been checkpointed — but the alternative is a
 *   portal that cannot start, and the file is kept rather than deleted so the
 *   loss is inspectable rather than assumed.
 */
/**
 * How long to wait for a previous process to let go of the database.
 *
 * DuckDB is single-writer, and a restart routinely overlaps the old process's
 * shutdown — it has up to ten seconds to finish its own sessions (see
 * index.ts's shutdown). Without this the new process throws
 *
 *     IO Error: Could not set lock on file "data/portal.duckdb"
 *
 * as an uncaught rejection before the server ever listens, so a redeploy that
 * is a second too quick looks like a crash rather than a wait. Restarting is
 * the single most common operation there is; it should not need a stopwatch.
 */
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 500;

export async function openDuckDB(file: string): Promise<DuckDBInstance> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      return await attachDuckDB(file);
    } catch (e) {
      const message = (e as Error).message ?? "";
      if (!/Conflicting lock|Could not set lock/i.test(message) || Date.now() >= deadline) throw e;
      if (!announced) {
        console.warn(
          `[duckdb] ${path.basename(file)} is still held by the previous process — waiting for it to exit`,
        );
        announced = true;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

async function attachDuckDB(file: string): Promise<DuckDBInstance> {
  try {
    return await DuckDBInstance.create(file);
  } catch (e) {
    const message = (e as Error).message ?? "";
    /**
     * The main file's own checkpoint metadata, not the WAL.
     *
     *     INTERNAL Error: Failed to load metadata pointer (id 31, idx 0, ptr 31)
     *
     * A checkpoint that was interrupted partway through leaves the block
     * metadata pointing at blocks that were never written, and DuckDB cannot
     * open the file at all — not even READ_ONLY, so there is nothing to
     * salvage in place and no query that recovers it.
     *
     * The WAL quarantine below already chose this shape and the reasoning is
     * the same, only sharper: refusing to start leaves the portal dead until
     * somebody logs into the host, and the alternative is not data loss —
     * the file is renamed, not deleted, so whatever a future DuckDB can make
     * of it is still there. What is *in* portal.duckdb is sessions, their
     * event logs and the audit trail; identity and memory are in graph.duckdb
     * and are a separate file precisely so that one of these can fail without
     * taking the agent with it.
     *
     * It is loud on purpose. A portal that silently came up with no history
     * would be worse than one that did not come up.
     */
    // Several messages, one condition: the file exists, claims to be a DuckDB
    // database, and cannot be read. Which one you get depends on which block
    // the interrupted write happened to leave inconsistent — a metadata
    // pointer into a block that was never written, or a block whose checksum
    // does not match what the header says it should be. Deliberately *not*
    // matched: "not a valid DuckDB database file", which is what a wrong path
    // gives you. Renaming somebody's notes.txt aside because we were pointed
    // at it is the one outcome worse than refusing to start.
    if (
      /Failed to load metadata pointer|Corrupt database file|does not match stored checksum/.test(message) ||
      /INTERNAL Error.*[Cc]heckpoint/.test(message) ||
      // A block that deserialises into the wrong shape — "field id mismatch,
      // expected: 100, got: 0" — is the same condition arriving through the
      // serialiser rather than the checksum. Seen on a 1.1 GB portal.duckdb
      // after a trim: the file is structurally intact enough to open and its
      // contents are not what the catalog says they are.
      /Serialization Error.*deserialize/.test(message)
    ) {
      const aside = `${file}.corrupt-${Date.now()}`;
      renameSync(file, aside);
      if (existsSync(`${file}.wal`)) renameSync(`${file}.wal`, `${aside}.wal`);
      console.error(
        `[duckdb] ${path.basename(file)} could not be opened — the file is damaged, which happens ` +
          `when a checkpoint is interrupted partway through writing. It has been moved ` +
          `to ${path.basename(aside)} and a new empty database created in its place, so the portal ` +
          `can start. Nothing has been deleted. Original error: ${message.split("\n")[0]}`,
      );
      return DuckDBInstance.create(file);
    }
    if (!/replaying WAL|WAL file/i.test(message)) throw e;
    const wal = `${file}.wal`;
    if (!existsSync(wal)) throw e;
    const quarantined = `${wal}.unreplayable-${Date.now()}`;
    renameSync(wal, quarantined);
    console.error(
      `[duckdb] ${path.basename(file)}: its write-ahead log could not be replayed and has been moved ` +
        `to ${path.basename(quarantined)} so the database can open. Anything written since the last ` +
        `checkpoint is in that file and is not in the database. Original error: ${message.split("\n")[0]}`,
    );
    return DuckDBInstance.create(file);
  }
}

/** Force everything in the WAL into the main file. See openDuckDB for why this is not optional. */
export async function checkpoint(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("CHECKPOINT");
  } catch {
    // A checkpoint can legitimately fail while another connection holds a
    // transaction open. Losing this one is not worth refusing to start: the
    // next one will catch up, and openDuckDB recovers the case where none does.
  }
}

/**
 * One statement at a time on the shared connection.
 *
 * `@duckdb/node-api` cannot run two statements concurrently on a single
 * connection, and this module has exactly one. That was survivable while the
 * only callers were graph tools — the model calls those one at a time — and
 * stopped being survivable the moment the memory injector began searching at
 * the start of a turn while the previous turn's extraction was still writing.
 * The failure is not a wrong answer:
 *
 *     [Error: Failed to execute prepared statement]
 *
 * as an *uncaught rejection*, which takes the whole portal down mid-conversation.
 *
 * Serialised per statement rather than per function, deliberately. These
 * functions call each other — upsertEdge calls getNode and upsertNode,
 * scopedRecall falls back to scopedSearch — so a lock taken at function level
 * would deadlock on the first nested call. Statements are the level at which
 * the constraint actually exists.
 *
 * This is not transaction isolation and does not pretend to be: a read-then-
 * write pair can still interleave with another. That race predates this and is
 * benign here, because upsertNode's rule is corroboration — the loser of a race
 * raises confidence rather than losing data.
 */
export function serialiseStatements(conn: DuckDBConnection): DuckDBConnection {
  let gate: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = gate.then(work, work);
    // The gate must survive a failed statement, or one error would wedge every
    // later query behind a rejected promise.
    gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return new Proxy(conn, {
    get(target, prop, receiver) {
      /**
       * Closing has to wait for the queue too.
       *
       * `closeSync` is not a statement, so it was passed straight through
       * while queued writes were still in flight — the file was closed
       * mid-write and left shorter than its own metadata claimed. DuckDB then
       * refused to open it:
       *
       *     IO Error: Could not read enough bytes from file
       *     "data/portal.duckdb": attempted to read 262144 bytes from
       *     location 485240832
       *
       * on a 459 MB file. Two databases were lost to this before the cause was
       * clear, and both times it looked like corruption rather than a bug in
       * the shutdown path — which is exactly what it was.
       *
       * `closeAfterPending` drains first, so a caller can shut down cleanly.
       * `closeSync` itself is deliberately left alone rather than made to
       * block: turning a synchronous call into a queued one silently changes
       * what it means, and a caller who genuinely wants "now" should get it.
       */
      if (prop === "closeAfterPending") {
        return async () => {
          await queue(async () => undefined);
          (target as unknown as { closeSync?: () => void }).closeSync?.();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "run" || prop === "runAndReadAll") && typeof value === "function") {
        return (...args: unknown[]) => queue(() => (value as Function).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DuckDBConnection;
}

async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      mkdirSync(DATA_DIR, { recursive: true });
      const instance = await openDuckDB(path.join(DATA_DIR, "graph.duckdb"));
      const raw = await instance.connect();
      await ensureSchema(raw);
      // Immediately, while nothing else is using the connection: this is the
      // half that stops the next unclean shutdown bricking the file.
      await checkpoint(raw);
      return serialiseStatements(raw);
    })();
  }
  return connPromise;
}

/**
 * Check the graph out cleanly and let go of its file.
 *
 * Called on the way down (index.ts). Without it the lock survives until the
 * process is actually reaped, and a restart inside that window fails to open
 * the database at all — which is what made every redeploy a race. The
 * checkpoint is the same one openDuckDB's WAL recovery exists to avoid needing.
 */
export async function closeGraph(): Promise<void> {
  if (!connPromise) return;
  const pending = connPromise;
  connPromise = null;
  try {
    const conn = await pending;
    await checkpoint(conn);
    // Drains the statement queue before closing — see serialiseStatements.
    await (conn as unknown as { closeAfterPending?: () => Promise<void> }).closeAfterPending?.();
  } catch {
    // Shutting down: a failure here costs the clean release, not the data.
  }
}

/** The live connection, for contracts that need to age a row to test decay. */
export const __conn = getConn;

/** Same identity rule as Sisyphean's `_node_key()` — a node's name, normalized, is its id. */
export const normalizeName = (name: string): string => name.trim().toLowerCase();

export async function getNode(name: string): Promise<NodeRow | undefined> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll("SELECT * FROM nodes WHERE id = $id", { id: normalizeName(name) });
  const rows = reader.getRowObjectsJson() as unknown as NodeRow[];
  return rows[0];
}

/**
 * Upsert a node, tracking confidence and corroboration — ports the rule from
 * Sisyphean's `GraphStore.upsert_node`: each re-observation nudges confidence
 * toward `min(max(existing, incoming) + 0.08, 0.95)`.
 *
 * Anchor nodes (identity ground-truths) are frozen: only an explicit
 * confidence >= 1.0 write updates their summary, everything else is a no-op
 * on content — the one piece of Sisyphean's logic worth keeping verbatim.
 */
/**
 * How alike two labels must be before they are the same thing.
 *
 * High on purpose. Merging is not reversible without provenance, and the cost
 * of missing a duplicate is a slightly noisier graph, where the cost of a wrong
 * merge is two unrelated facts fused into one that is now wrong about both.
 */
const DEDUP_SIMILARITY = 0.93;

/** Types where near-duplicate labels are worth merging. Caches are keyed, not named. */
const DEDUP_TYPES = "('concept', 'fact', 'skill')";

/**
 * The node an incoming claim is really about, if one already exists.
 *
 * Deduplication was exact-name-only, so "Gemma model" and "the Gemma model"
 * accumulated as two nodes that would never merge and — before decay existed —
 * never fade either. Both then corroborated separately, so the graph grew more
 * confident about a thing it could not tell was one thing.
 *
 * Compared against the *same text* upsertNode embeds — `name: summary`, not the
 * bare name. The first version probed with the label alone against stored
 * vectors of label-plus-summary, which is comparing unlike things: real
 * duplicates measured 0.98 label-to-label and well under the threshold once the
 * summary was on one side only, so nothing ever merged and the feature looked
 * like it worked. It takes the vector upsertNode has already computed, so this
 * costs no extra call.
 *
 * Needs embeddings and returns nothing without them, rather than guessing from
 * string overlap: measured against this embedder, "Qdrant server" and "Qdrant
 * client" sit at 0.88 — close as text, different subjects — where genuine
 * duplicates sit at 0.98. The threshold lives in that gap.
 */
async function existingSynonym(
  vec: number[] | undefined,
  name: string,
  type: NodeType,
): Promise<string | undefined> {
  if (!DEDUP_TYPES.includes(`'${type}'`) || !vec) return undefined;

  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `SELECT id, array_cosine_similarity(embedding, $q) AS sim
       FROM nodes
      WHERE embedding IS NOT NULL AND type IN ${DEDUP_TYPES} AND id != $id
      ORDER BY sim DESC LIMIT 1`,
    { q: arrayValue(vec), id: normalizeName(name) },
    { q: ARRAY(FLOAT, EMBEDDING_DIM) },
  );
  const top = reader.getRowObjectsJson()[0] as any;
  return top && Number(top.sim) >= DEDUP_SIMILARITY ? String(top.id) : undefined;
}

export async function upsertNode(
  name: string,
  type: NodeType,
  summary = "",
  confidence?: number,
  /** category: `user`-node sub-typing. expiresAt: TTL for `tool_cache`/`page` nodes. source: where this came from, unioned across observations. */
  extra?: { category?: string; expiresAt?: Date | string; source?: string },
): Promise<string> {
  const conn = await getConn();
  let id = normalizeName(name);
  let existing = await getNode(name);

  // Embedded first, so the same vector serves both the duplicate probe below
  // and the row itself. Two uses, one call.
  const probe = !existing && summary ? await embedText(`${name}: ${summary}`) : undefined;

  /**
   * Before creating a node, check whether it is one we already have under a
   * slightly different label — see existingSynonym. Only for genuinely new
   * names: an exact hit is already the same node, and re-checking would spend
   * an embedding call on every corroboration.
   */
  if (!existing) {
    const synonym = await existingSynonym(probe, name, type);
    if (synonym) {
      const reader = await conn.runAndReadAll("SELECT * FROM nodes WHERE id = $id", { id: synonym });
      const row = (reader.getRowObjectsJson() as unknown as NodeRow[])[0];
      if (row) {
        id = row.id;
        existing = row;
      }
    }
  }
  // Only worth re-embedding when the summary actually changes — same text
  // embedded twice wastes a round trip to the embedding server for nothing.
  const embedding = probe ?? (summary ? await embedText(`${name}: ${summary}`) : undefined);
  const embeddingParam = embedding ? arrayValue(embedding) : null;
  const category = extra?.category ?? null;
  // Unioned rather than replaced: two sources agreeing is the evidence the
  // confidence rule is already built on, and overwriting would throw away the
  // one that came first.
  const source = extra?.source?.trim() || null;
  // listValue, not arrayValue: sources is a variable-length TEXT[] (a LIST),
  // where `embedding` is a fixed-width FLOAT[768] (an ARRAY). DuckDB treats
  // them as different types and a plain JS array is neither.
  const merged = source
    ? Array.from(new Set([...(existing?.sources ?? []), source]))
    : null;
  const sources = merged ? listValue(merged) : null;
  // TIMESTAMPTZ, bound as an absolute instant (microseconds since epoch) —
  // not a formatted string. A naive TIMESTAMP column previously took this as
  // literal wall-clock text, and DuckDB's now() (also TIMESTAMPTZ) runs in
  // the session's local timezone, not UTC — a JS `.toISOString()` string
  // compared against that came out skewed by however far apart the two are.
  const expiresAtDate = extra?.expiresAt
    ? extra.expiresAt instanceof Date
      ? extra.expiresAt
      : new Date(extra.expiresAt)
    : undefined;
  const expiresAt = expiresAtDate ? timestampTZValue(BigInt(expiresAtDate.getTime()) * 1000n) : null;
  const bindTypes = { embedding: ARRAY(FLOAT, EMBEDDING_DIM), expiresAt: TIMESTAMPTZ };

  if (existing) {
    if (existing.type === "anchor") {
      if (confidence !== undefined && confidence >= 1.0 && summary) {
        await conn.run(
          "UPDATE nodes SET summary = $summary, embedding = $embedding, last_seen = now() WHERE id = $id",
          { summary, embedding: embeddingParam, id },
          { embedding: ARRAY(FLOAT, EMBEDDING_DIM) },
        );
      } else {
        await conn.run("UPDATE nodes SET last_seen = now() WHERE id = $id", { id });
      }
    } else {
      const base = confidence !== undefined ? Math.max(existing.confidence, confidence) : existing.confidence;
      const nextConfidence = Math.min(base + 0.08, 0.95);
      await conn.run(
        `UPDATE nodes SET type = $type,
                          summary = CASE WHEN $summary != '' THEN $summary ELSE summary END,
                          embedding = CASE WHEN $summary != '' THEN $embedding ELSE embedding END,
                          confidence = $confidence,
                          observations = observations + 1,
                          category = COALESCE($category, category),
                          sources = COALESCE($sources, sources),
                          expires_at = COALESCE($expiresAt, expires_at),
                          last_seen = now()
         WHERE id = $id`,
        { type, summary, embedding: embeddingParam, confidence: nextConfidence, category, sources, expiresAt, id },
        bindTypes,
      );
    }
  } else {
    const initConfidence = confidence !== undefined ? Math.min(Math.max(confidence, 0), 1) : 0.5;
    await conn.run(
      `INSERT INTO nodes (id, type, name, summary, confidence, observations, embedding, category, sources, expires_at)
       VALUES ($id, $type, $name, $summary, $confidence, 1, $embedding, $category, $sources, $expiresAt)`,
      { id, type, name, summary, confidence: initConfidence, embedding: embeddingParam, category, sources, expiresAt },
      bindTypes,
    );
  }
  dirty = true;
  return id;
}

/** Upsert an edge; either endpoint missing is created as a bare `fact` node, matching Sisyphean's behavior. */
export async function upsertEdge(source: string, relation: string, target: string, weight = 1.0): Promise<void> {
  const conn = await getConn();
  for (const name of [source, target]) {
    if (!(await getNode(name))) await upsertNode(name, "fact");
  }
  const sourceId = normalizeName(source);
  const targetId = normalizeName(target);
  const existing = await conn.runAndReadAll(
    "SELECT weight FROM edges WHERE source_id = $sourceId AND target_id = $targetId AND relation = $relation",
    { sourceId, targetId, relation },
  );
  if (existing.getRowObjectsJson().length) {
    await conn.run(
      "UPDATE edges SET weight = weight + $weight WHERE source_id = $sourceId AND target_id = $targetId AND relation = $relation",
      { weight, sourceId, targetId, relation },
    );
  } else {
    await conn.run(
      "INSERT INTO edges (source_id, target_id, relation, weight) VALUES ($sourceId, $targetId, $relation, $weight)",
      { sourceId, targetId, relation, weight },
    );
  }
  dirty = true;
}

async function ensureFtsIndex(conn: DuckDBConnection): Promise<void> {
  if (!dirty) return;
  await conn.run("PRAGMA create_fts_index('nodes', 'id', 'name', 'summary', overwrite=1)");
  dirty = false;
}

/** Keyword search, scored by BM25 match weighted by confidence — the DB-native analog of Sisyphean's hand-rolled token-overlap scoring. */
export async function searchNodes(query: string, limit = 10, type?: NodeType): Promise<NodeRow[]> {
  const conn = await getConn();
  await ensureFtsIndex(conn);
  // `type` narrows the search to one kind of node — asking "what episodes
  // mention this" without every fact that also does. Bound rather than
  // interpolated, and omitted entirely when not asked for so the planner sees
  // the same query it always did.
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (score) FROM (
       SELECT *, fts_main_nodes.match_bm25(id, $query) AS score FROM nodes
     )
     WHERE score IS NOT NULL ${type ? "AND type = $type" : ""}
     ORDER BY score * confidence DESC
     LIMIT $limit`,
    type ? { query, limit, type } : { query, limit },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

/**
 * Semantic search: embeds the query and ranks nodes by cosine similarity ×
 * confidence — matches on meaning, not just shared words, so "pet" finds a
 * node whose summary says "cat" with no literal overlap. Falls back to
 * `searchNodes` (keyword) whenever the embedding server is unreachable or
 * nothing is embedded yet, so callers never need to branch on availability —
 * same fallback contract Sisyphean's `search_by_embedding` used.
 */
export async function searchNodesSemantic(query: string, limit = 10, type?: NodeType): Promise<NodeRow[]> {
  const queryVec = await embedText(query);
  if (!queryVec) return searchNodes(query, limit, type);

  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (sim) FROM (
       SELECT *, array_cosine_similarity(embedding, $q) AS sim FROM nodes WHERE embedding IS NOT NULL
     )
     WHERE sim > 0.3 ${type ? "AND type = $type" : ""}
     ORDER BY sim * confidence DESC
     LIMIT $limit`,
    type ? { q: arrayValue(queryVec), limit, type } : { q: arrayValue(queryVec), limit },
    { q: ARRAY(FLOAT, EMBEDDING_DIM) },
  );
  const hits = reader.getRowObjectsJson() as unknown as NodeRow[];
  return hits.length ? hits : searchNodes(query, limit, type);
}

/**
 * The most recently touched nodes, newest first — no query, just "what's
 * changed lately." Ports BirdClaw's `_dream_reflect` input exactly: it hands
 * the model the last 20 knowledge-graph nodes and asks it to find patterns,
 * contradictions and connections across them, rather than searching for
 * something specific. This is the read half of that; the reflection prompt
 * itself lives in the self-reflection routine's seeded instructions.
 */
export async function recentNodes(limit = 20): Promise<NodeRow[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    "SELECT * FROM nodes ORDER BY last_seen DESC LIMIT $limit",
    { limit },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

const NODE_COLUMNS = "b.id, b.type, b.name, b.summary, b.confidence, b.observations, b.created_at, b.last_seen";

/**
 * Both of these were DuckPGQ `GRAPH_TABLE`/`MATCH` queries. They are plain SQL
 * now, and the extension is gone.
 *
 * It crashed the process. On a graph of more than a handful of nodes,
 * traversal raised `INTERNAL Error: Attempted to access index 8 within vector
 * of size 8` from inside the extension — on a background task thread, so it
 * was not catchable at the call site and took the whole portal down with it.
 * `neighbors()` is what `graph_recall` expands its hits with, so the loop
 * reached this on its own, unattended, as the graph grew.
 *
 * Nothing is lost by dropping it. One hop is a join, and n hops is a
 * recursive CTE — both are ordinary DuckDB, which is already here and does
 * not need `INSTALL ... FROM community` at startup. What goes with it: the
 * pin holding `@duckdb/node-api` at 1.4.4 (DuckPGQ published no build for
 * 1.5.x, which is the only reason that pin existed), and the escaping
 * workaround below it — GRAPH_TABLE would not accept bound parameters, so
 * every id had to be spliced in as a quoted literal. These take parameters
 * like any other query, so a node named "O'Brien's project" is no longer a
 * question about quoting.
 */

const NEIGHBOR_COLUMNS = "n.id, n.type, n.name, n.summary, n.confidence, n.observations, n.created_at, n.last_seen";

/** Immediate neighbors in both directions, with the relation label — one hop. */
export async function neighbors(name: string): Promise<NeighborRow[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `SELECT ${NEIGHBOR_COLUMNS}, e.relation AS relation, 'out' AS direction
       FROM edges e JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id = $id
     UNION ALL
     SELECT ${NEIGHBOR_COLUMNS}, e.relation AS relation, 'in' AS direction
       FROM edges e JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id = $id`,
    { id: normalizeName(name) },
  );
  return reader.getRowObjectsJson() as unknown as NeighborRow[];
}

/**
 * Everything reachable within `depth` hops, without per-edge relation labels
 * — matches Sisyphean's `bfs()` depth (2 by default), for callers that want
 * the wider neighborhood rather than just direct links.
 *
 * Undirected, following an edge either way, which is what the old MATCH did
 * not do and what a "what is this connected to" question actually means: a
 * fact linked *to* a project is as relevant to that project as one linked
 * from it. `UNION` rather than `UNION ALL` inside the CTE so a cycle
 * terminates instead of running forever.
 */
export async function traverse(name: string, depth = 2): Promise<NodeRow[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `WITH RECURSIVE reachable(id, depth) AS (
       SELECT $id, 0
       UNION
       SELECT CASE WHEN e.source_id = r.id THEN e.target_id ELSE e.source_id END, r.depth + 1
         FROM reachable r
         JOIN edges e ON e.source_id = r.id OR e.target_id = r.id
        WHERE r.depth < $depth
     )
     SELECT n.* FROM nodes n JOIN reachable r ON r.id = n.id WHERE n.id <> $id`,
    { id: normalizeName(name), depth: Math.max(1, Math.trunc(depth)) },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

/**
 * The rest of BirdClaw's GraphStore surface, which its test suite asserts and
 * this port had not needed until now.
 *
 * `removeNode` is the one that was actually missing something: cleanup could
 * only prune by age, expiry or category, so a single wrong belief could not be
 * taken out — an agent that writes its own memory needs to be able to correct
 * it, not only wait for it to get old. The other three are conveniences the
 * same suite checks.
 */

/** Every node of one type. */
/**
 * Enough of the graph to draw, in one query rather than a walk.
 *
 * `neighbors` answers "what is next to this", which is the right shape for the
 * agent and the wrong one for a picture: drawing a hundred nodes that way is a
 * hundred round trips, and the result depends on where you happened to start.
 *
 * Ordered by confidence and recency so a truncated graph is the *interesting*
 * part of it rather than an arbitrary slice — a picture of a memory should show
 * what the agent is most sure of and most recently thought about, not the first
 * two hundred rows on disk.
 *
 * Edges are filtered to the nodes returned, so nothing dangles: an edge to a
 * node that was cut is not a hint of something beyond the frame, it is a line
 * to nowhere.
 */
export async function graphSnapshot(
  limit = 200,
  type?: NodeType,
): Promise<{ nodes: NodeRow[]; edges: { source: string; relation: string; target: string; weight: number }[] }> {
  const conn = await getConn();
  const nodeRows = await conn.runAndReadAll(
    `SELECT * FROM nodes ${type ? "WHERE type = $type" : ""}
      ORDER BY confidence DESC, last_seen DESC LIMIT $limit`,
    type ? { type, limit } : { limit },
  );
  const nodes = nodeRows.getRowObjectsJson() as unknown as NodeRow[];
  if (!nodes.length) return { nodes: [], edges: [] };

  const ids = new Set(nodes.map((n) => n.id));
  const edgeRows = await conn.runAndReadAll(
    "SELECT source_id, relation, target_id, weight FROM edges LIMIT 5000",
  );
  const edges = (edgeRows.getRowObjectsJson() as unknown as {
    source_id: string;
    relation: string;
    target_id: string;
    weight: number;
  }[])
    .filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
    .map((e) => ({ source: e.source_id, relation: e.relation, target: e.target_id, weight: Number(e.weight) }));

  return { nodes, edges };
}

export async function nodesByType(type: NodeType, limit = 1000): Promise<NodeRow[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    "SELECT * FROM nodes WHERE type = $type ORDER BY last_seen DESC LIMIT $limit",
    { type, limit },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

/** How many nodes there are, in total or of one type. */
export async function nodeCount(type?: NodeType): Promise<number> {
  const conn = await getConn();
  const reader = type
    ? await conn.runAndReadAll("SELECT count(*) AS n FROM nodes WHERE type = $type", { type })
    : await conn.runAndReadAll("SELECT count(*) AS n FROM nodes");
  return Number((reader.getRowObjectsJson()[0] as any)?.n ?? 0);
}

/**
 * Delete one node and every edge touching it. True when it existed.
 *
 * Anchors are exempt: identity is not something a stray call removes. Rewrite
 * one through identity.ts instead, which is the deliberate path.
 */
export async function removeNode(name: string): Promise<boolean> {
  const conn = await getConn();
  const id = normalizeName(name);
  const existing = await getNode(id);
  if (!existing || existing.type === "anchor") return false;
  return (await deleteNodesWhere(conn, "id = $id", { id })) > 0;
}

// --- the permeable boundary ---
//
// One graph, not one graph per project — a `user`/`skill` fact learned in
// one workspace is still true in another, and keeping one graph is what lets
// a search surface it there too. What must not happen is a `fact` or
// `episode` from an unrelated project reading as current here. The fence is
// a `scoped_to` edge from a scoped node to a `project` anchor (one per
// distinct workspace path); a node with no such edge is unscoped and visible
// everywhere on purpose (that's how `user`/`skill` nodes stay global).
// scopedSearch/scopedRecall below are the only place this filter is applied
// — every other reader in this file is already scope-blind by design and
// stays that way; callers who need the fence ask for it explicitly.

/** The `project` anchor node for a workspace path, created on first use. */
export async function projectAnchor(cwd: string): Promise<string> {
  return upsertNode(cwd, "project", `Workspace at ${cwd}`);
}

/** Fences a node to one project: invisible to scopedSearch/scopedRecall from any other. */
export async function scopeToProject(name: string, cwd: string): Promise<void> {
  await projectAnchor(cwd);
  await upsertEdge(name, "scoped_to", cwd);
}

const SCOPE_FILTER = (alias: string) => `(
       NOT EXISTS (SELECT 1 FROM edges se WHERE se.source_id = ${alias}.id AND se.relation = 'scoped_to')
       OR EXISTS (SELECT 1 FROM edges se WHERE se.source_id = ${alias}.id AND se.relation = 'scoped_to' AND se.target_id = $projectId)
     )`;

/**
 * Memory that belongs to the *project*, and is fenced to it.
 *
 * A note about repo A is noise in repo B, and a cached page or tool result is
 * meaningless outside the tree it was read in. Everything else belongs to the
 * person the agent works for and travels with them — see personalRecall.
 */
const PROJECT_BOUND = "('workspace_note', 'tool_cache', 'page')";

/**
 * The fence as a *ranking* signal rather than a filter.
 *
 * Project-bound types stay fenced. Everything else — conversations, facts about
 * the person, the agent's own identity — is returned wherever it was recorded,
 * with same-project hits ranked above the rest so the work in hand still wins.
 *
 * The filter version of this had a failure that looked exactly like amnesia.
 * Asked "what are my plans for Thursday" in /workspaces/test1234, the agent
 * found nothing, went hunting the filesystem — ls, ls .., grep, ls
 * /workspaces/, ls /workspaces/self/ — and answered that it did not know. The
 * conversation where that was said had been harvested faithfully, and scoped to
 * /workspaces/test. One directory across, and the memory was invisible: a
 * meeting on Thursday is a fact about a person, not about a repository, and
 * standing in a different folder does not make it stop being true.
 */
const SOFT_SCOPE = (alias: string) => `(
       ${alias}.type NOT IN ${PROJECT_BOUND}
       OR NOT EXISTS (SELECT 1 FROM edges se WHERE se.source_id = ${alias}.id AND se.relation = 'scoped_to')
       OR EXISTS (SELECT 1 FROM edges se WHERE se.source_id = ${alias}.id AND se.relation = 'scoped_to' AND se.target_id = $projectId)
     )`;

/** 1.0 for a hit in this project, a shade less elsewhere: nearer work ranks first. */
const SCOPE_BONUS = (alias: string) => `(CASE WHEN EXISTS (
       SELECT 1 FROM edges se WHERE se.source_id = ${alias}.id AND se.relation = 'scoped_to' AND se.target_id = $projectId
     ) THEN 1.0 ELSE 0.85 END)`;

/**
 * Fresher memory ranks above staler memory of equal strength.
 *
 * Confidence says how well established something is; it says nothing about
 * whether it is still current. Without this a fact recorded in March and never
 * revisited outranks one from yesterday purely because it had been corroborated
 * more often back when it was being discussed — which is exactly backwards for
 * anything that changes.
 *
 * A gentle curve, not a cliff: full weight for a fortnight, then easing toward
 * 0.6 over a quarter and never below it. Old is not wrong, and a settled fact
 * from a year ago should still surface when nothing newer speaks to the
 * question — it just should not beat something fresher that does.
 *
 * Separate from decay, which lowers the stored confidence of things nobody
 * re-observes. This only reorders what a search returns and changes nothing on
 * disk, so a search ordering can be tuned without rewriting the graph's beliefs.
 */
const RECENCY_BONUS = (alias: string) =>
  `greatest(0.6, 1.0 - (date_diff('day', ${alias}.last_seen, now()) - 14) * 0.005)`;

/**
 * What the memory injector searches: everything the person could reasonably
 * expect to be remembered, ranked with the current project first.
 */
/**
 * Embed nodes that have no vector yet.
 *
 * `upsertNode` embeds on write, which means a node written while no embedding
 * server was reachable has no vector and never gets one — semantic search
 * simply cannot see it, however good the server is once it arrives. Standing
 * up the embedding model does not retroactively make a memory findable, and
 * nothing said so: search quietly stayed keyword-only over 51 existing nodes.
 *
 * Runs in the background at boot, in small batches, with the whole thing
 * abandoned on the first failure. It is catch-up work — the alternative to
 * doing it slowly is not doing it faster, it is blocking startup on a model
 * server that may not be there.
 */
export async function backfillEmbeddings(batch = 25): Promise<number> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `SELECT id, name, summary FROM nodes
      WHERE embedding IS NULL AND summary != '' ORDER BY last_seen DESC LIMIT $batch`,
    { batch },
  );
  const rows = reader.getRowObjectsJson() as unknown as { id: string; name: string; summary: string }[];
  if (!rows.length) return 0;

  let embedded = 0;
  for (const row of rows) {
    const vec = await embedText(`${row.name}: ${row.summary}`);
    // The server is unreachable or has changed shape: stop rather than walk
    // the whole table failing once per node.
    if (!vec) break;
    await conn.run(
      "UPDATE nodes SET embedding = $embedding WHERE id = $id",
      { embedding: arrayValue(vec), id: row.id },
      { embedding: ARRAY(FLOAT, EMBEDDING_DIM) },
    );
    embedded++;
  }
  if (embedded) dirty = true;
  return embedded;
}

/** How many nodes are still waiting for a vector. */
export async function unembeddedCount(): Promise<number> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    "SELECT count(*) AS n FROM nodes WHERE embedding IS NULL AND summary != ''",
  );
  return Number((reader.getRowObjectsJson()[0] as any)?.n ?? 0);
}

export async function personalRecall(query: string, cwd: string, limit = 10): Promise<NodeRow[]> {
  const conn = await getConn();
  const projectId = normalizeName(cwd);
  const queryVec = await embedText(query);

  if (queryVec) {
    const reader = await conn.runAndReadAll(
      `SELECT * EXCLUDE (sim) FROM (
         SELECT *, array_cosine_similarity(embedding, $q) AS sim FROM nodes WHERE embedding IS NOT NULL
       ) n
       WHERE sim > 0.3 AND ${SOFT_SCOPE("n")}
       ORDER BY sim * confidence * ${SCOPE_BONUS("n")} * ${RECENCY_BONUS("n")} DESC
       LIMIT $limit`,
      { q: arrayValue(queryVec), projectId, limit },
      { q: ARRAY(FLOAT, EMBEDDING_DIM) },
    );
    const hits = reader.getRowObjectsJson() as unknown as NodeRow[];
    if (hits.length) return hits;
  }

  await ensureFtsIndex(conn);
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (score) FROM (
       SELECT *, fts_main_nodes.match_bm25(id, $query) AS score FROM nodes
     ) n
     WHERE score IS NOT NULL AND ${SOFT_SCOPE("n")}
     ORDER BY score * confidence * ${SCOPE_BONUS("n")} * ${RECENCY_BONUS("n")} DESC
     LIMIT $limit`,
    { query, projectId, limit },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

/** searchNodes, fenced to `cwd`'s project plus whatever is unscoped. */
export async function scopedSearch(query: string, cwd: string, limit = 10): Promise<NodeRow[]> {
  const conn = await getConn();
  await ensureFtsIndex(conn);
  const projectId = normalizeName(cwd);
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (score) FROM (
       SELECT *, fts_main_nodes.match_bm25(id, $query) AS score FROM nodes
     ) n
     WHERE score IS NOT NULL AND ${SCOPE_FILTER("n")}
     ORDER BY score * confidence DESC
     LIMIT $limit`,
    { query, projectId, limit },
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}

/** searchNodesSemantic, fenced to `cwd`'s project plus whatever is unscoped. */
export async function scopedRecall(query: string, cwd: string, limit = 10): Promise<NodeRow[]> {
  const queryVec = await embedText(query);
  if (!queryVec) return scopedSearch(query, cwd, limit);

  const conn = await getConn();
  const projectId = normalizeName(cwd);
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (sim) FROM (
       SELECT *, array_cosine_similarity(embedding, $q) AS sim FROM nodes WHERE embedding IS NOT NULL
     ) n
     WHERE sim > 0.3 AND ${SCOPE_FILTER("n")}
     ORDER BY sim * confidence DESC
     LIMIT $limit`,
    { q: arrayValue(queryVec), projectId, limit },
    { q: ARRAY(FLOAT, EMBEDDING_DIM) },
  );
  const hits = reader.getRowObjectsJson() as unknown as NodeRow[];
  return hits.length ? hits : scopedSearch(query, cwd, limit);
}

// --- cleanup ---
//
// anchor/user/project are never pruned by age or expiry — permanent by type,
// the same rule BirdClaw enforces via _PERMANENT_NODE_TYPES. Everything else
// is fair game for routine_cleanup.
const PERMANENT_TYPES = new Set<NodeType>(["anchor", "user", "project"]);

/**
 * Deletes both the node and any edge touching it — a node alone would leave
 * a dangling edge referencing an id that no longer exists in `nodes`, which
 * `edges`'s own FOREIGN KEY constraints refuse.
 */
async function deleteNodesWhere(conn: DuckDBConnection, where: string, params: Record<string, any>): Promise<number> {
  const before = await conn.runAndReadAll(`SELECT id FROM nodes WHERE ${where}`, params);
  const ids = before.getRowObjectsJson().map((r: any) => r.id as string);
  if (!ids.length) return 0;
  await conn.run(
    `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE ${where}) OR target_id IN (SELECT id FROM nodes WHERE ${where})`,
    params,
  );
  await conn.run(`DELETE FROM nodes WHERE ${where}`, params);
  dirty = true;
  return ids.length;
}

/** Deletes tool_cache/page nodes past their expires_at. Returns how many. */
export async function pruneExpired(): Promise<number> {
  const conn = await getConn();
  return deleteNodesWhere(conn, "expires_at IS NOT NULL AND expires_at < now()", {});
}

/**
 * Let unrepeated beliefs lose standing.
 *
 * Confidence only ever rose. `upsertNode` nudges it toward
 * `min(max(existing, incoming) + 0.08, 0.95)` on every re-observation and
 * nothing ever moved it the other way, while `routine_cleanup` ages out only
 * caches and episodes — never `fact` or `concept`. So a belief recorded once,
 * wrongly, on a thin afternoon outranked fresher knowledge forever, and an
 * autonomous loop writing into that graph made the problem worse the longer it
 * ran.
 *
 * Under "verify, don't recall" this is not hygiene, it is correctness: a claim
 * nobody has seen again in a month should not be asserted with the same force
 * as one confirmed yesterday. Decay is what makes an unverified belief fade
 * instead of harden.
 *
 * Deliberately gentle, and deliberately floored. ×0.9 a month is slow enough
 * that a genuinely settled fact re-observed even occasionally stays high, and
 * the floor at 0.1 means nothing is ever silently erased — a decayed belief is
 * still findable, still correctable, and still says when it was last seen. It
 * is demotion, not deletion, and `anchor`/`user`/`project` are exempt entirely
 * for the same reason they are exempt from pruning: identity and the person
 * are not claims that go stale.
 */
/**
 * Link up the nodes nothing points at.
 *
 * Ports Sisyphean's `_cluster_isolated_nodes` (`memory/dream.py`). Extraction
 * writes a node per fact, and a run of web searches on one subject produces a
 * handful of them that share nothing but the minute they were written in. They
 * are findable by search and unreachable by traversal, which makes them
 * half-remembered: the agent can retrieve "Absurdism" if it happens to ask for
 * it by name, and will never arrive there from "Existentialism".
 *
 * The heuristic is Sisyphean's and it is deliberately crude: nodes with no
 * edges, created close together in time, are almost certainly from the same
 * piece of work. Their shared words name a topic, a concept node is created
 * for it, and each member is attached. Nothing here is a claim about the world
 * — `part_of` a topic node is a statement about how these were gathered, which
 * is exactly what the timestamps support and no more.
 *
 * Runs from the dream cycle, where a wrong grouping is cheap: it adds an edge
 * that recall may follow, not a fact the agent will assert.
 */
const CLUSTERABLE = new Set(["fact", "concept", "page", "episode"]);

/** Words too common to name a topic. */
const TOPIC_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "is", "are", "was", "were", "for",
  "with", "that", "this", "it", "its", "how", "what", "why", "can", "does", "has", "have", "been",
  "meaning", "means", "mean", "view", "views", "about", "from", "into", "their", "there", "which",
  "using", "used", "use", "when", "where", "than", "then", "them", "they", "some", "more", "most",
]);

/** The words a majority of these names share, best first. */
export function topicWords(names: string[], minShare = 0.5): string[] {
  if (names.length < 2) return [];
  const counts = new Map<string, number>();
  for (const name of names) {
    const words = new Set(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !TOPIC_STOP.has(w)),
    );
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(names.length * minShare));
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w)
    .slice(0, 3);
}

export async function clusterIsolatedNodes(
  windowMinutes = 15,
  minMembers = 3,
): Promise<{ clusters: number; linked: number }> {
  const conn = await getConn();
  const rows = (
    await conn.runAndReadAll(
      `SELECT n.id, n.name, n.type, n.created_at FROM nodes n
       WHERE n.id NOT IN (SELECT source_id FROM edges UNION SELECT target_id FROM edges)
       ORDER BY n.created_at ASC`,
    )
  ).getRowObjectsJson() as unknown as Array<{ id: string; name: string; type: string; created_at: string }>;

  const candidates = rows.filter((r) => CLUSTERABLE.has(r.type) && r.created_at);
  if (candidates.length < minMembers) return { clusters: 0, linked: 0 };

  // Buckets of nodes written close together — the same piece of work.
  const buckets: Array<typeof candidates> = [];
  let current: typeof candidates = [];
  let anchorAt = 0;
  for (const row of candidates) {
    const at = new Date(row.created_at.replace(" ", "T")).getTime();
    if (!Number.isFinite(at)) continue;
    if (!current.length || at - anchorAt <= windowMinutes * 60_000) {
      if (!current.length) anchorAt = at;
      current.push(row);
    } else {
      if (current.length >= minMembers) buckets.push(current);
      current = [row];
      anchorAt = at;
    }
  }
  if (current.length >= minMembers) buckets.push(current);

  let clusters = 0;
  let linked = 0;
  for (const bucket of buckets) {
    const words = topicWords(bucket.map((r) => r.name));
    // No shared vocabulary means these were written at the same time and are
    // about nothing in common — a coincidence of scheduling, not a topic.
    if (!words.length) continue;
    const topic = words.join(" ");
    await upsertNode(
      topic,
      "concept",
      `A topic these were gathered under: ${bucket.map((r) => r.name).slice(0, 8).join(", ")}.`,
      // Low: this is an observation about when things were written, not a
      // claim that they belong together.
      0.4,
      { source: "clustering" },
    );
    clusters++;
    for (const member of bucket) {
      await upsertEdge(member.name, "part_of", topic, 0.5);
      linked++;
    }
  }
  return { clusters, linked };
}

/**
 * Say what a placeholder edge actually means.
 *
 * Ports Sisyphean's `_refine_relations`. The extractor writes `related_to`
 * when it sees two things mentioned together and cannot tell how they relate —
 * which is honest, and useless to anyone reading the graph afterwards. An edge
 * that says "these co-occurred" carries no more than the fact that both nodes
 * exist.
 *
 * A short focused question answers it far better than extraction could, because
 * extraction was reading a page and this is looking at two summaries with
 * nothing else competing for attention. Sisyphean sized the prompt for a 0.6B
 * model; the constraint here is not capability but cost, so it is bounded per
 * run and skips anything already specific.
 *
 * Failure is silence throughout. An unrefined edge is exactly what it was
 * before, and a graph maintenance pass must never be able to damage the graph
 * it is tidying: the answer is accepted only if it is short, verb-like, and not
 * the placeholder it replaces.
 */
const RELATION_SYSTEM = [
  "You are given two things from a knowledge graph and asked how the first relates to the second.",
  "",
  "Answer with a short verb phrase, two to four words, lower case, no punctuation — the label for",
  'an arrow from the first to the second: "is a kind of", "was written by", "depends on",',
  '"contradicts", "is part of", "caused".',
  "",
  'If you cannot tell from what you are given, answer exactly: unknown',
].join("\n");

/** A label worth storing: short, verb-like, and not the placeholder itself. */
export function usableRelation(answer: string | undefined): string | undefined {
  if (!answer) return undefined;
  const text = answer.trim().toLowerCase().replace(/^["'`]|["'`.]+$/g, "").trim();
  if (!text || text === "unknown" || text === "related_to" || text === "related to") return undefined;
  const words = text.split(/\s+/);
  if (words.length > 5 || text.length > 40) return undefined;
  // A single noun is not a relation; a label has to say what one thing does to
  // the other, or the edge is no better than the placeholder.
  if (words.length < 2 && !/(s|ed|es)$/.test(text)) return undefined;
  if (/[<>{}[\]|]/.test(text)) return undefined;
  return text.replace(/\s+/g, "_");
}

export async function refineRelations(
  limit = 20,
  ask: (system: string, user: string) => Promise<string | undefined> = (system, user) =>
    complete(system, user, { maxTokens: 24, temperature: 0.1 }),
): Promise<number> {
  const conn = await getConn();
  const rows = (
    await conn.runAndReadAll(
      `SELECT e.source_id, e.target_id, s.name AS source_name, s.summary AS source_summary,
              t.name AS target_name, t.summary AS target_summary
       FROM edges e
       JOIN nodes s ON s.id = e.source_id
       JOIN nodes t ON t.id = e.target_id
       WHERE e.relation = 'related_to'
         AND s.type NOT IN ('anchor', 'tool_cache')
         AND t.type NOT IN ('anchor', 'tool_cache')
       LIMIT $limit`,
      { limit },
    )
  ).getRowObjectsJson() as unknown as Array<Record<string, string>>;

  let refined = 0;
  for (const row of rows) {
    let answer: string | undefined;
    try {
      answer = await ask(
        RELATION_SYSTEM,
        `First: ${row.source_name}\n${(row.source_summary ?? "").slice(0, 300)}\n\n` +
          `Second: ${row.target_name}\n${(row.target_summary ?? "").slice(0, 300)}\n\n` +
          `How does the first relate to the second?`,
      );
    } catch {
      continue;
    }
    const relation = usableRelation(answer);
    if (!relation) continue;
    try {
      await conn.run(
        `UPDATE edges SET relation = $relation
         WHERE source_id = $source AND target_id = $target AND relation = 'related_to'`,
        { relation, source: row.source_id, target: row.target_id },
      );
      refined++;
    } catch {
      // A row that will not update is left as it was.
    }
  }
  return refined;
}

export async function decayStaleBeliefs(
  olderThanDays = 30,
  factor = 0.9,
  floor = 0.1,
): Promise<number> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `UPDATE nodes
        SET confidence = greatest($floor, confidence * $factor)
      WHERE type NOT IN ('anchor', 'user', 'project')
        AND last_seen < now() - to_days($days)
        AND confidence > $floor
      RETURNING id`,
    { floor, factor, days: Math.max(1, Math.trunc(olderThanDays)) },
  );
  const decayed = reader.getRowObjectsJson().length;
  if (decayed) dirty = true;
  return decayed;
}

/** Deletes nodes of `type` older (by last_seen) than `maxAgeDays`. No-op for a permanent type. */
export async function pruneByAge(type: NodeType, maxAgeDays: number): Promise<number> {
  if (PERMANENT_TYPES.has(type)) return 0;
  const conn = await getConn();
  return deleteNodesWhere(conn, "type = $type AND last_seen < now() - to_days($days)", {
    type,
    days: Math.max(0, Math.trunc(maxAgeDays)),
  });
}

/** Deletes nodes of `type` whose `category` matches exactly — memory-cache.ts's invalidatePath. */
export async function deleteNodesByCategory(type: NodeType, category: string): Promise<number> {
  const conn = await getConn();
  return deleteNodesWhere(conn, "type = $type AND category = $category", { type, category });
}
