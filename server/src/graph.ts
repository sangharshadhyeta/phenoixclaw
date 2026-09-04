import {
  ARRAY,
  arrayValue,
  DuckDBInstance,
  FLOAT,
  TIMESTAMPTZ,
  timestampTZValue,
  type DuckDBConnection,
} from "@duckdb/node-api";
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
export async function openDuckDB(file: string): Promise<DuckDBInstance> {
  try {
    return await DuckDBInstance.create(file);
  } catch (e) {
    const message = (e as Error).message ?? "";
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

async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      mkdirSync(DATA_DIR, { recursive: true });
      const instance = await openDuckDB(path.join(DATA_DIR, "graph.duckdb"));
      const conn = await instance.connect();
      await ensureSchema(conn);
      // Immediately, while nothing else is using the connection: this is the
      // half that stops the next unclean shutdown bricking the file.
      await checkpoint(conn);
      return conn;
    })();
  }
  return connPromise;
}

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
export async function upsertNode(
  name: string,
  type: NodeType,
  summary = "",
  confidence?: number,
  /** category: `user`-node sub-typing. expiresAt: TTL for `tool_cache`/`page` nodes. Both optional, both only meaningful for the new node types. */
  extra?: { category?: string; expiresAt?: Date | string },
): Promise<string> {
  const conn = await getConn();
  const id = normalizeName(name);
  const existing = await getNode(name);
  // Only worth re-embedding when the summary actually changes — same text
  // embedded twice wastes a round trip to the embedding server for nothing.
  const embedding = summary ? await embedText(`${name}: ${summary}`) : undefined;
  const embeddingParam = embedding ? arrayValue(embedding) : null;
  const category = extra?.category ?? null;
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
                          expires_at = COALESCE($expiresAt, expires_at),
                          last_seen = now()
         WHERE id = $id`,
        { type, summary, embedding: embeddingParam, confidence: nextConfidence, category, expiresAt, id },
        bindTypes,
      );
    }
  } else {
    const initConfidence = confidence !== undefined ? Math.min(Math.max(confidence, 0), 1) : 0.5;
    await conn.run(
      `INSERT INTO nodes (id, type, name, summary, confidence, observations, embedding, category, expires_at)
       VALUES ($id, $type, $name, $summary, $confidence, 1, $embedding, $category, $expiresAt)`,
      { id, type, name, summary, confidence: initConfidence, embedding: embeddingParam, category, expiresAt },
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
