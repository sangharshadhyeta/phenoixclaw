# Architecture

Express server, React front end, DuckDB for state, pi driven through its SDK.

```
browser ──HTTP──▶ express ──▶ session manager ──▶ pi (SDK, in process)
   ▲                              │
   └──────── SSE ─────────────────┴──▶ event log (DuckDB)
```

## Fire and forget

The property everything else follows from: **a run belongs to the server, not to
a request**.

`POST /prompt` resolves as soon as pi accepts the message. The browser can close
immediately. Every event pi emits is appended to the `events` table with a
monotonic `seq`, and the SSE endpoint replays from a client's cursor before
tailing. Reconnect after a week and you get everything you missed.

The one exception is extension dialogs, which are strictly live. A persisted
dialog would be replayed to every future reader — reloading the page reopened a
menu whose extension had stopped waiting years in agent-time. They are emitted
with a negative `seq` so they can never be confused with stored history.

## Executors

An executor decides where pi actually runs. Both satisfy the same `PiClient`
interface, so the rest of the portal does not care which is in use.

### host (default)

pi runs **in the portal's process** through its SDK. Fast, and it is what makes
extension slash commands work — `session.prompt()` runs registered commands,
which the RPC transport accepted and then silently dropped.

The trade is isolation: a crash takes the portal with it, and pi has the
portal's own permissions.

### container

pi runs in a throwaway Docker container with only the workspace mounted,
speaking the JSONL RPC protocol over stdio. Capabilities dropped,
`no-new-privileges`, memory and CPU ceilings, labelled so a crashed portal can
still reap it.

Set `EXECUTOR=container` and mount the Docker socket.

## Session lifecycle

A pi process starts lazily — on the first prompt, or when something reads the
session's config. On start:

1. `ModelRuntime.create()`
2. A `DefaultResourceLoader` for extensions, skills and prompt templates. It
   needs **both** `cwd` and `agentDir`; omitting either throws, which once left
   every session with no extensions at all.
3. Resolve the requested model — may miss, see below
4. `SessionManager.open(file, sessionDir, cwd)` if the session has a stored file,
   else `create(cwd, sessionDir)`
5. `bindExtensions()` with a UI context, which is what makes interactive
   commands work
6. **Resolve the model again.** Extensions register their own providers, so a
   `llama-server` model does not exist until step 5 has run. Without the second
   pass, a session asking for a local model silently ran on pi's fallback.

::: tip Why the session file is stored
`SessionManager.create()` starts a *new* conversation every time. Calling it on
each boot meant a restart lost the history and reset context usage to zero.
Storing pi's session file path and reopening it by path is what makes a session
survive a redeploy — `continueRecent()` would also work but guesses, and one
stray file would attach the wrong conversation.
:::

## Data

The portal's own state lives in `portal.duckdb`, one file, one connection —
DuckDB rather than SQLite. Same reasoning as the [knowledge
graph](#knowledge-graph) below: a real embedded database with indexing and a
schema, instead of hand-rolled files, and one engine for the whole app instead
of two.

| Table | Holds |
| --- | --- |
| `sessions` | Title, workspace, status, per-session model and effort, pinned, pi session file, role, last speaker |
| `events` | Append-only log, one row per event, indexed by `(session_id, seq)` |
| `channels` | Configured channels and their credentials |
| `routines` | Standing instructions, schedule, and the outcome of the last run — see [Routines](/guide/routines) |
| `people` | Everyone who's ever spoken to the agent, including strangers it turned away |
| `questions` | A colleague's question waiting on the primary user's answer |
| `grants` | A one-off tool approval, spent once and expiring in 15 minutes |
| `notes` | Something the portal said into a conversation while nobody was listening, held for its next turn |
| `tool_rules` | Standing exceptions to what a non-primary role may run |
| `audit` | What the [guard](/guide/security) decided, and why — kept to the last 2,000 entries |
| `settings` | Portal-wide overrides |

Migrations run in place — `ALTER TABLE` plus a check against
`information_schema.columns` (DuckDB has no `PRAGMA table_info`) — rather than
recreating anything, so upgrades keep existing sessions and their history.

## Knowledge graph

A second DuckDB file, `graph.duckdb` — deliberately separate from
`portal.duckdb` rather than another table in it, since a fact's lifecycle
(confidence, corroboration, no decay) is nothing like a session's. Two tables:

| Table | Holds |
| --- | --- |
| `nodes` | Typed facts (`user`, `project`, `concept`, `fact`, `skill`, plus a protected `anchor` type) — name, summary, a confidence score, and an embedding |
| `edges` | Directed, labelled relations between nodes, with a weight that strengthens on repetition |

**Corroboration, not overwrite.** Re-observing something the graph already
knows nudges its confidence toward `min(max(existing, incoming) + 0.08,
0.95)` rather than replacing it outright — the same rule Sisyphean's
`GraphRAG.upsert_node` used. `anchor` nodes are frozen: only an explicit
confidence of `1.0` updates one, everything else is a no-op on content. There
is no decay or forgetting yet — a node's confidence only ever goes up.

**Search is hybrid.** Keyword search uses DuckDB's own FTS extension
(`PRAGMA create_fts_index`), ranked by BM25 score × confidence. Semantic
search embeds the query — a CPU-only server running `nomic-embed-text-v1.5`
(768 dimensions), configured via `EMBEDDING_BASE_URL` — and ranks by
`array_cosine_similarity(embedding, query) × confidence`. Falls back to
keyword search whenever the embedding server is unreachable or nothing is
embedded yet, so a caller never has to branch on availability.

**Traversal uses DuckPGQ**, a community property-graph extension
(`GRAPH_TABLE`/`MATCH` queries), rather than hand-written joins.

::: warning DuckPGQ pins the DuckDB version
DuckPGQ has no build published for DuckDB 1.5.x yet, so `@duckdb/node-api` is
pinned to `1.4.4` — the last version DuckPGQ is confirmed to work against.
This pin may need to move again once DuckPGQ catches up; don't bump
`@duckdb/node-api` without checking.
:::

Two tools put this in the agent's hands: `graph_remember(name, type, summary,
relations?)` writes a node and optionally links it, and `graph_recall(query,
limit?)` runs the hybrid search and expands each hit's neighbors one hop. Both
are registered unconditionally — every session, not just routines — because
remembering a durable fact is an ordinary-conversation thing.

`memory_digest` is a third tool, registered only for the self-reflection
routine's session (see [Dream Cycle](/guide/routines#dream-cycle)): it reads
raw conversation text from `portal.duckdb`'s `events` table since a stored
watermark, splits it into identity-relevant and general chunks by keyword
match, and hands it back as the raw material the Dream Cycle folds into the
graph and into `SELF_CONCEPT.md`/`INNER_LIFE.md`.

## Front end

React with react-router. Every meaningful view has a URL — a session, the
sessions list, the agents page, each settings tab — so deep links and the back
button work, with an SPA fallback on the server.

State is polled every five seconds and pushed over SSE for the open session.

## Channel loading

Channel packages are discovered from two roots: the repo's `channels/` directory
for builtins, and `CHANNELS_DIR/node_modules` for installed ones. A package is
considered only if `package.json` carries the `pithagoras.channel` marker.

Each module is imported with a cache-busting query so a reinstall is picked up
without a restart, its manifest is validated, and duplicate channel ids are
rejected. A package that throws is collected into a `broken` list with its error
rather than being skipped.

Installation shells out to `npm install` in `CHANNELS_DIR`, which is why every
spec form npm understands works without the portal parsing any of them.
