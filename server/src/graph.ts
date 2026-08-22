import { ARRAY, arrayValue, DuckDBInstance, FLOAT, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The knowledge graph — nodes/edges in DuckDB, replacing the NetworkX+JSON
 * store Sisyphean used. Same semantics (typed nodes, confidence/corroboration,
 * anchor protection, keyword search weighted by confidence), a real database
 * underneath instead of a hand-rolled JSON file with no indexing or schema.
 *
 * Traversal uses DuckPGQ (SQL/PGQ property-graph queries via GRAPH_TABLE/
 * MATCH) rather than hand-written joins. DuckPGQ has no build published for
 * DuckDB's latest minor (1.5.x) — this pins @duckdb/node-api to 1.4.4, the
 * last version DuckPGQ is confirmed to work against. DuckPGQ is a trailing
 * community extension, so this pin may need to move again once it catches up.
 */

export type NodeType = "anchor" | "user" | "project" | "concept" | "fact" | "skill";

export interface NodeRow {
  id: string;
  type: string;
  name: string;
  summary: string;
  confidence: number;
  observations: number;
  created_at: string;
  last_seen: string;
}

/**
 * A dedicated CPU-only embedding server (nomic-embed-text-v1.5, 768 dims) —
 * kept separate from the chat model's llama-server because that one runs
 * without `--embeddings` and sits at the edge of the GPU's memory budget
 * already (confirmed: 42 MiB free out of 12288 before this was added).
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
  await conn.run(`
    CREATE TABLE IF NOT EXISTS edges (
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      relation TEXT NOT NULL,
      weight DOUBLE NOT NULL DEFAULT 1.0
    )
  `);
  // CREATE TABLE IF NOT EXISTS is a no-op against an existing database, so a
  // column added after nodes already existed on disk needs its own migration.
  const columns = await conn.runAndReadAll("SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'");
  const names = new Set(columns.getRowObjectsJson().map((r: any) => r.column_name as string));
  if (!names.has("embedding")) {
    await conn.run(`ALTER TABLE nodes ADD COLUMN embedding FLOAT[${EMBEDDING_DIM}]`);
  }

  await conn.run("INSTALL fts");
  await conn.run("LOAD fts");
  await conn.run("INSTALL duckpgq FROM community");
  await conn.run("LOAD duckpgq");
  await conn.run(`
    CREATE PROPERTY GRAPH IF NOT EXISTS knowledge
      VERTEX TABLES (nodes)
      EDGE TABLES (edges SOURCE KEY (source_id) REFERENCES nodes (id)
                         DESTINATION KEY (target_id) REFERENCES nodes (id))
  `);
}

async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      mkdirSync(DATA_DIR, { recursive: true });
      const instance = await DuckDBInstance.create(path.join(DATA_DIR, "graph.duckdb"));
      const conn = await instance.connect();
      await ensureSchema(conn);
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
): Promise<string> {
  const conn = await getConn();
  const id = normalizeName(name);
  const existing = await getNode(name);
  // Only worth re-embedding when the summary actually changes — same text
  // embedded twice wastes a round trip to the embedding server for nothing.
  const embedding = summary ? await embedText(`${name}: ${summary}`) : undefined;
  const embeddingParam = embedding ? arrayValue(embedding) : null;
  const embeddingType = { embedding: ARRAY(FLOAT, EMBEDDING_DIM) };

  if (existing) {
    if (existing.type === "anchor") {
      if (confidence !== undefined && confidence >= 1.0 && summary) {
        await conn.run(
          "UPDATE nodes SET summary = $summary, embedding = $embedding, last_seen = now() WHERE id = $id",
          { summary, embedding: embeddingParam, id },
          embeddingType,
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
                          last_seen = now()
         WHERE id = $id`,
        { type, summary, embedding: embeddingParam, confidence: nextConfidence, id },
        embeddingType,
      );
    }
  } else {
    const initConfidence = confidence !== undefined ? Math.min(Math.max(confidence, 0), 1) : 0.5;
    await conn.run(
      "INSERT INTO nodes (id, type, name, summary, confidence, observations, embedding) VALUES ($id, $type, $name, $summary, $confidence, 1, $embedding)",
      { id, type, name, summary, confidence: initConfidence, embedding: embeddingParam },
      embeddingType,
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
export async function searchNodes(query: string, limit = 10): Promise<NodeRow[]> {
  const conn = await getConn();
  await ensureFtsIndex(conn);
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (score) FROM (
       SELECT *, fts_main_nodes.match_bm25(id, $query) AS score FROM nodes
     )
     WHERE score IS NOT NULL
     ORDER BY score * confidence DESC
     LIMIT $limit`,
    { query, limit },
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
export async function searchNodesSemantic(query: string, limit = 10): Promise<NodeRow[]> {
  const queryVec = await embedText(query);
  if (!queryVec) return searchNodes(query, limit);

  const conn = await getConn();
  const reader = await conn.runAndReadAll(
    `SELECT * EXCLUDE (sim) FROM (
       SELECT *, array_cosine_similarity(embedding, $q) AS sim FROM nodes WHERE embedding IS NOT NULL
     )
     WHERE sim > 0.3
     ORDER BY sim * confidence DESC
     LIMIT $limit`,
    { q: arrayValue(queryVec), limit },
    { q: ARRAY(FLOAT, EMBEDDING_DIM) },
  );
  const hits = reader.getRowObjectsJson() as unknown as NodeRow[];
  return hits.length ? hits : searchNodes(query, limit);
}

const NODE_COLUMNS = "b.id, b.type, b.name, b.summary, b.confidence, b.observations, b.created_at, b.last_seen";

/**
 * DuckPGQ's GRAPH_TABLE/MATCH doesn't accept bound parameters in its WHERE
 * clause (confirmed directly: both named `$id` and positional `?` fail with
 * "Failed to retrieve bind parameter index"/"Failed to bind value" — a real
 * limitation of this still-young extension, not a usage mistake). The id is
 * always our own `normalizeName()` output, but may echo user-supplied text
 * (e.g. a node named "O'Brien's project"), so it's escaped as a SQL string
 * literal rather than trusted as one.
 */
const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Immediate neighbors in both directions, with the relation label — one hop. */
export async function neighbors(name: string): Promise<NeighborRow[]> {
  const conn = await getConn();
  const id = sqlLiteral(normalizeName(name));
  // Sequential, not Promise.all: a single DuckDBConnection runs one
  // statement at a time — concurrent queries on it fail the same way.
  const out = await conn.runAndReadAll(
    `FROM GRAPH_TABLE (knowledge
       MATCH (a:nodes)-[e:edges]->(b:nodes)
       WHERE a.id = ${id}
       COLUMNS (${NODE_COLUMNS}, e.relation AS relation, 'out' AS direction))`,
  );
  const inn = await conn.runAndReadAll(
    `FROM GRAPH_TABLE (knowledge
       MATCH (a:nodes)<-[e:edges]-(b:nodes)
       WHERE a.id = ${id}
       COLUMNS (${NODE_COLUMNS}, e.relation AS relation, 'in' AS direction))`,
  );
  return [...out.getRowObjectsJson(), ...inn.getRowObjectsJson()] as unknown as NeighborRow[];
}

/**
 * Everything reachable within `depth` hops (outbound), without per-edge
 * relation labels — matches Sisyphean's `bfs()` depth (2 by default), for
 * callers that want the wider neighborhood rather than just direct links.
 */
export async function traverse(name: string, depth = 2): Promise<NodeRow[]> {
  const conn = await getConn();
  const id = sqlLiteral(normalizeName(name));
  const reader = await conn.runAndReadAll(
    `FROM GRAPH_TABLE (knowledge
       MATCH (a:nodes)-[e:edges]->{1,${Math.max(1, Math.trunc(depth))}}(b:nodes)
       WHERE a.id = ${id}
       COLUMNS (${NODE_COLUMNS}))`,
  );
  return reader.getRowObjectsJson() as unknown as NodeRow[];
}
