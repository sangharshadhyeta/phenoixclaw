# Phoenixclaw — Architecture Map & Code Review

Reviewed 2026-09-05 against `phoenixclaw-main` @ `c52fd28f8`, plus the uncommitted
self-concept work in the tree. ~12.5k lines of server TypeScript, ~8.1k of web.

This document has two halves. **Part 1** maps what the application is and how the
pieces fit. **Part 2** is the review: bugs and dangling items, ordered by severity,
each with a file:line and a concrete failure scenario.

Findings marked **[proven]** were reproduced by running the code, not inferred.

---

# Part 1 — Architecture

## 1.1 What it is

An Express + React portal around the [pi coding agent](https://github.com/earendil-works/pi).
The whole design follows from one invariant:

> **A run belongs to the server, not to a request.**

`POST /api/sessions/:id/prompt` returns as soon as pi *accepts* the message. Every
event pi emits is appended to a DuckDB `events` table with a monotonic `seq`.
`GET /api/sessions/:id/events` (SSE) replays from the client's `?since=` cursor,
then tails. Close the browser mid-run, come back a week later, get everything.

The one deliberate exception: extension dialogs are emitted with a **negative `seq`**
and never persisted — a stored dialog would be replayed to every future reader,
reopening a menu whose extension stopped waiting long ago.

Internal package names are still `pithagoras` (npm workspaces, the
`pithagoras.channel` marker). That is the old name, not a separate project. The
channel marker is a load-bearing public contract.

## 1.2 Runtime layout

```
browser ──HTTP──▶ express ──▶ session manager ──▶ pi (SDK, in process)
   ▲                              │
   └──────── SSE ─────────────────┴──▶ event log (portal.duckdb)
                                  │
                                  └──▶ knowledge graph (graph.duckdb)
```

| Module | Responsibility |
| --- | --- |
| `server/src/index.ts` | Express app. Inline routes for auth/settings/workspaces/sessions, then mounts `api/*` routers. SPA fallback for the web build. |
| `server/src/session-manager.ts` | The lifecycle. Lazily starts pi per session, tracks status, fans events to SSE and the event log, serialises appends per session. |
| `server/src/executors/index.ts` | `host` (pi in-process via SDK) vs `container` (throwaway Docker container over JSONL RPC). Both satisfy `PiClient`. |
| `server/src/pi/*` | Everything injected *into* a pi session: the guard, and the tool sets. |
| `server/src/db.ts` | `portal.duckdb`. One connection, migrations by `ALTER TABLE` + `information_schema.columns` checks. |
| `server/src/graph.ts` | `graph.duckdb`. Separate knowledge graph — nodes/edges, hybrid FTS + embedding search. |
| `server/src/channels/` | Loader + supervisor for channel packages. |
| `server/src/routines/` | Cron parser + supervisor for scheduled and quiet-triggered work. |
| `web/src/` | React + react-router + Tailwind. Polls every 5s; the open session also streams SSE. |

## 1.3 Session kinds

`SessionRow.kind` decides tool availability and context files. Check the column,
never infer from cwd.

| Kind | Origin | cwd | Gets |
| --- | --- | --- | --- |
| `task` | A workspace you created in the UI | the workspace | No identity tools, no routine tools. Gets workspace-context snapshot. |
| `agent` | Arrived through a channel | agent home | Identity tools **and** routine-scheduling tools. |
| `routine` | Owned by a schedule | agent home or the routine's workspace | Identity tools, report tool, self-maintenance. No scheduling tools. |

The `task` exclusion is a deliberate token-budget decision: every tool's schema sits
in the prompt from the first token. A coding session against someone's checkout has
no business rewriting `SELF_CONCEPT.md`, and paying for the option on every turn cost
~3k tokens per session.

## 1.4 Session boot order (`pi/sdk-client.ts`)

Each of these steps has already been a bug. In order:

1. `ModelRuntime.create()`
2. `DefaultResourceLoader` — needs **both** `cwd` and `agentDir`; omitting either
   throws and leaves the session with no extensions at all.
3. **Resolve the model** — may miss.
4. `SessionManager.open(file, sessionDir, cwd)` if a session file is stored, else
   `create(cwd, sessionDir)`. Note the argument order.
5. `bindExtensions()` with a `uiContext` — what makes interactive commands work.
6. **Resolve the model again.** Extensions register their own providers, so a
   `llama-server` model does not exist until step 5 has run.

The stored `pi_session_file` is reopened *by path*. `SessionManager.create()` would
start a fresh conversation (losing history, resetting context usage to 0%);
`continueRecent()` guesses and one stray file attaches the wrong conversation.

`appendSystemPrompt` must be a **`string[]`** as of pi 0.83. A bare string silently
produces no injection at all, with no error anywhere.

## 1.5 Data model

### `portal.duckdb`

| Table | Holds |
| --- | --- |
| `sessions` | Title, workspace, status, per-session model/effort, pinned, pi session file, role, last speaker |
| `events` | Append-only log, one row per event, indexed `(session_id, seq)` |
| `tasks` | The checklist inside one session, ordered by `seq` (rewritable — replanning is the point) |
| `channels` | Configured channels and credentials |
| `routines` | Standing instructions, schedule, last-run outcome |
| `people` | Everyone who has spoken to the agent, including strangers turned away |
| `questions` | A colleague's question waiting on the primary user |
| `grants` | A one-off tool approval, spent once, expiring in 15 minutes |
| `notes` | Something the portal said while nobody was listening, held for the next turn |
| `tool_rules` | Standing exceptions to what a non-primary role may run |
| `audit` | What the guard decided and why — last 20,000 entries, allowed calls included |
| `settings` | Portal-wide overrides |

### `graph.duckdb`

Deliberately a separate file: a fact's lifecycle (confidence, corroboration, no
decay) is nothing like a session's.

- **`nodes`** — typed facts. `anchor` (frozen identity), `user`, `project`,
  `concept`, `fact`, `skill`, plus memory extras `episode`, `workspace_note`,
  `tool_cache`, `page`. Carries name, summary, confidence, embedding, optional
  `category`, optional TTL.
- **`edges`** — directed labelled relations with a weight that strengthens on
  repetition.

**Corroboration, not overwrite**: re-observing nudges confidence toward
`min(max(existing, incoming) + 0.08, 0.95)`. `anchor` nodes are frozen — only an
explicit confidence of `1.0` updates one.

**Search is hybrid**: DuckDB FTS (BM25 × confidence), or embeddings
(`array_cosine_similarity × confidence`) when `EMBEDDING_BASE_URL` is reachable.
Falls back to keyword silently, so callers never branch on availability.

**Traversal is plain SQL** — a join for one hop, a recursive CTE for several.
DuckPGQ was removed: it raised an internal assertion from a background thread and
took the whole portal down. Its removal freed the `@duckdb/node-api` 1.4.4 pin.

> **Never put a `FOREIGN KEY` on a table whose parent rows get updated.** DuckDB
> rewrites `UPDATE` on a referenced table as delete+insert and trips its own
> constraint, which froze every node that had an edge.

> **Migrations must be followed by `CHECKPOINT`.** An `ALTER TABLE ADD COLUMN` left
> in the WAL cannot be replayed when the table has `now()` defaults, and the
> database then refuses to open at all. `openDuckDB()` quarantines an unreplayable
> WAL rather than failing to start.

## 1.6 Identity lives in the graph, not on disk

`SOUL.md`, `PrimaryUser.md`, `MEMORY.md`, `SELF_CONCEPT.md`, `INNER_LIFE.md` are
`anchor` nodes in `graph.duckdb` (`server/src/identity.ts`). Disk is a
human-readable, git-diffable **mirror only**. This is what lets a task session —
whose cwd is the workspace, not agent home — still know who it is.

Read them through `readIdentity()`, never `readFileSync`.

**Role gates which files load** (`filesFor()` in `pi/sdk-client.ts`):

| Role | Files |
| --- | --- |
| `primary` | `SOUL.md`, `PrimaryUser.md`, `MEMORY.md`, `INNER_LIFE.md` |
| everyone else | `SOUL.md`, `INNER_LIFE.md` |

`PrimaryUser.md` and `MEMORY.md` are one person's private notes — a teammate
messaging the bot must not get an agent carrying them.

`CONSTITUTION.md` is the deliberate exception: disk-only, human-edited, injected
only into self-update and autonomous sessions, protected by `PROTECTED_PATHS`. Kept
out of the graph and out of ordinary session context.

## 1.7 Two security layers (`pi/guard.ts`)

### Layer 1 — taint / injection guard

Premise: the model *will* eventually follow instructions hidden in content it reads.
Nothing in a system prompt reliably prevents that, so the guard doesn't try — it
limits what a turn can do *after* reading something untrusted.

- **`tool_result`**: output from an untrusted source is wrapped in
  `<<<untrusted:...>>>` markers with a **random per-result id**. A fixed marker
  would be a password printed in a public repo — the injected message would close
  the block itself and everything after would read as trusted. Anything already
  shaped like a marker is defaced before wrapping.
- **`tool_call`**: once tainted, six rules refuse — `pipe-to-shell`,
  `write-to-path`, `upload`, `read-credentials`, `publish`, `persist`, plus
  `self-rewrite` (`identity_update` / `skill_write` / `remember_user`).

Rules are **tainted-only on purpose** — ordinary coding sessions never meet them. A
routine can be exempted, which still logs to `audit` as `allowed-by-exemption`.

> **Untrusted-source detection is a name list** (`isUntrustedSource`), not
> provenance. A pi package installed through the Packages tab registers whatever
> tool names it likes, so anything reading the outside world under an unknown name
> must be declared in `UNTRUSTED_TOOLS` or it silently bypasses the guard.

### Layer 2 — people / roles

`primary` / `colleague` / `guest` / `blocked`, identified by platform id scoped by
channel (`telegram:100200300`), **never by display name**.

Colleague permission is an **allowlist** — `read`, `grep`, `find`, `ls`,
`ask_primary`, plus explicit `tool_rules` — so any tool added later starts outside
it. Checked **per tool call**, because the speaker changes between turns in a group.
An allowed bash command carrying `;`, `|`, `` ` ``, `&`, `<`, `>` or `$(` is refused:
an allowlist that can be suffixed with anything is not an allowlist.

### Layer 3 — the constitution (autonomous turns)

`pi/constitution.ts` is a *separate* ceiling for turns nobody asked for. It composes
with the taint rules rather than replacing them. `AUTONOMOUS_TOOLS` is an allowlist
of ~28 names; everything else is refused citing a clause (`harm`, `privacy`,
`reversible`). `bash`, `write`, `edit`, `routine_create/update/run` and all MCP tools
are refused as a class.

## 1.8 Tool inventory

| Tool | Module | Registered for |
| --- | --- | --- |
| `graph_remember`, `graph_recall`, `graph_reflect`, `graph_episode`, `workspace_note` | `graph-tools` | every session |
| `graph_ingest`, `find_symbol` | `knowledge-tools` | every session |
| `web_fetch`, `web_search` | `web-tools` | every session |
| cached `read` / `ls` overrides | `cached-tools` | every session |
| `task_plan`, `task_list`, `task_start`, `task_finish` | `task-tools` | every session with an id |
| `identity_read`, `identity_update`, `self_conclude`, `self_review` | `identity-tools` | non-`task` sessions |
| `remember_user` | `user-tools` | `primary` role only |
| `routines_list`, `routine_create`, `routine_update`, `routine_run` | `routine-tools` | `agent` sessions only |
| `dream_progress`, `routine_cleanup` | `routine-tools` | sessions with a `routineSlug` |
| `skill_write` | `skill-tools` | autonomous sessions |
| `ask_primary` | `ask-primary` | non-primary roles |
| `report` | `report-tool` | routines with a report target |
| `memory_digest` | `memory-digest` | the `self-reflection` routine only |

## 1.9 Routines and schedules

Two trigger kinds that are **not** cron, handled in `routines/supervisor.ts`:

- **`@idle`** — occasional and deep. 10 minutes of quiet, then at most once every
  3 hours. The Dream Cycle ships on it.
- **`@continuous`** — the learning loop. 60s of quiet, no minimum gap. Considered
  **last** in each tick and only if nothing else wanted to run, or it would starve
  every `@idle` routine outright.

"Quiet" excludes routine sessions (`lastHumanActivity()`), or the loop's own runs
would reset the clock forever. Real activity arriving **aborts** an in-flight quiet
run (`pauseIdleDreaming`).

Three routines are seeded once, guarded by slug so a restart never recreates them:

| Slug | Schedule | Enabled | Autonomous |
| --- | --- | --- | --- |
| `self-reflection` (Dream Cycle, 8 phases) | `@idle` | yes | yes |
| `learning-loop` (ORIENT → PLAN → WORK → DEEPEN → RECORD) | `@continuous` | yes | yes |
| `self-update` (patches Phoenixclaw or pi-source) | `@idle` | **no** | no |

## 1.10 Channels

Packages discovered from two roots: the repo's `channels/` for the four builtins
(telegram, slack, discord, webhook), and `CHANNELS_DIR/node_modules` for installed
ones. A package is considered only if `package.json` carries the
`pithagoras.channel` marker.

Each module is imported with a cache-busting query so a reinstall is picked up
without a restart. Duplicate channel ids are rejected; a package that throws is
collected into a `broken` list with its error rather than being skipped.

Sessions are keyed `<channel slug>:<package key>` — the **slug**, not the channel id,
because ids are regenerated when a channel is deleted and recreated, which silently
orphaned every conversation it had.

## 1.11 HTTP API surface

Everything under `/api` is behind `requireAuth` except `/api/auth/*`. The cookie is
an HMAC of an expiry stamp — no session store.

```
auth        GET  /api/auth/status          POST /api/auth/login
settings    GET  /api/settings             PUT  /api/settings
workspaces  GET  /api/workspaces           POST /api/workspaces
sessions    GET|POST /api/sessions         GET|PATCH|DELETE /api/sessions/:id
            POST /api/sessions/:id/prompt        (returns on accept)
            GET  /api/sessions/:id/events        (SSE, replay-then-tail)
            POST /api/sessions/:id/abort  /ui-response  /compact
            GET  /api/sessions/:id/config /models /commands /tasks
agent       GET|POST /api/agent/sessions   GET|POST /api/agent/setup
            PUT  /api/agent/files/:name
routers     /packages /extensions /channels /routines /skills /mcp /people /memory
```

Front-end routes: `/`, `/sessions`, `/agent`, `/routines`, `/audit`, `/memory`,
`/s/:sessionId`, `/s/:sessionId/settings/:tab`, `/settings/:tab`.

## 1.12 Operational constraints

- pi has **no approval prompts by design** — it runs with its process's
  permissions. That is why `PORTAL_PASSWORD` is required and why this is meant for
  Tailscale/LAN, not the public internet. **Egress is not restricted.**
- Persistent state must live under `/data`: `HOME=/data/home`, `AGENT_HOME`,
  `CHANNELS_DIR`, `SESSION_DIR`, `/data/bin` on `PATH`.
- The local model is a reasoning model whose thinking shares the answer's token
  budget. `llm.ts` sends `chat_template_kwargs: {enable_thinking: false}` for that
  reason. Without it, extraction calls burn the budget deliberating and return empty
  `content` with `finish_reason: "length"` — indistinguishable from having nothing
  to say. Don't remove it; don't "fix" a silent extraction failure by raising
  `max_tokens`.
- **DuckDB is single-writer.** A restart that races the old process produces an
  uncaught exception at boot, not a retry. Wait for the old PID to exit.

## 1.13 Test and typecheck gates

```bash
npm test                  # 8 contracts, 140 assertions, no network
npm run build -w server   # tsc
npm run build -w web      # tsc -b && vite build
```

Contracts: knowledge graph, pruner, web reader, symbol finder, local-model client,
cleanup (what age-based pruning may not delete, plus the ALTER TABLE behaviour the
migrations depend on), self-concept (that conclusions are reachable, separable, and
not writable by a page the agent just read), and guard (that protected paths hold
against a shell command, and that a taint outlives the process).
The graph contract catches things `tsc` cannot, which is why it exists. Run all
three after server changes.

---

# Part 2 — Review

## 2.1 Critical

### C1 — `routine_cleanup` deletes the user's routines and pinned sessions **[proven — FIXED]**

`server/src/db.ts:701` (`pruneOldRecords`), reached from
`server/src/pi/routine-tools.ts:395`.

```sql
DELETE FROM sessions WHERE updated_at < $cutoff;
DELETE FROM routines WHERE updated_at < $cutoff;
```

A routine **run** updates `last_run`, `last_status`, `last_output`, `last_ms` and
`next_run` — see `routines/supervisor.ts:228,267` and `:136` — but **never
`updated_at`**. So `updated_at` stays at creation time for any routine nobody has
hand-edited. After 30 days every seeded routine looks stale regardless of how
faithfully it has been running.

`routine_cleanup` is on the constitution's `AUTONOMOUS_TOOLS` allowlist
(`constitution.ts:83`) and is **PHASE 7 of the seeded Dream Cycle**
(`db.ts:1016`). So the agent does this to itself, unprompted, on a schedule.

Reproduction (fresh DB, routines aged 40 days, `learning-loop` given a successful
run *today*, one pinned session):

```
seeded routines: self-reflection, learning-loop, self-update
before: routines=3 sessions=1 events=1 tasks=1
pruneOldRecords(30) reported: { sessions: 1, routines: 3 }
after:  routines=0 sessions=0 events=1 tasks=1
surviving routines: []
orphaned events rows pointing at a deleted session: 1
orphaned tasks rows: 1
```

All three routines gone, including the one that ran today and the one running the
cleanup. The pinned session gone. Its events and tasks left behind as orphans.

Three separate defects here:

1. **Routines should not be age-pruned at all.** A routine is configuration, not
   history. Nothing else in the system treats standing config as expirable.
2. **`pinned` is ignored** for sessions. Pinning is the user saying "keep this".
3. **No cascade** — see C2.

Minimum fix: drop the `routines` delete entirely; add `AND pinned = 0 AND kind !=
'routine'` to the sessions delete; delete child rows first. If routine pruning is
genuinely wanted, gate it on `enabled = 0 AND last_run IS NULL` — the same
conservative test `seedSelfUpdateRoutines` already uses at `db.ts:1194` when
retiring the routines it replaced.

**Fixed.** `pruneOldRecords` no longer touches `routines` at all — a routine is
configuration, not history, and has no natural age. The narrower "never enabled and
never ran" test was tried and rejected: `self-update` is seeded in exactly that state
deliberately, so it would have deleted the feature before the user ever saw it.
Removing a routine is now only ever a person's decision, through
`DELETE /api/routines/:id`. Session pruning gained `AND s.pinned = 0` and an
exclusion for any session whose routine still exists, and both delete paths now
cascade (see H1). The tool's own description was corrected to stop promising it
prunes routines. Locked in by `server/test/cleanup-contract.mjs`.


## 2.2 High

### H1 — Deleting a session orphans four tables **[FIXED]**

`server/src/db.ts:511` (`deleteSession`) removes `events` and `sessions` only.
Five tables carry `session_id`: `events`, `tasks`, `questions`, `grants`, `notes`.

`DELETE /api/sessions/:id` therefore leaves `tasks`, `questions`, `grants` and
`notes` rows pointing at nothing. `grants` is the one that matters for security — an
unspent, unexpired approval outliving its session — though `useGrant` also matches
on `session_id`, so a stale grant is unreachable rather than exploitable. The rest is
unbounded growth. `pruneOldRecords` cleans none of them, not even `events`.

**Fixed.** Both delete paths go through a single `deleteSessionRows()` helper over
`SESSION_CHILD_TABLES` (`events`, `tasks`, `questions`, `grants`, `notes`). Written
out rather than expressed as `FOREIGN KEY`s, for the DuckDB reason in §1.5.


### H2 — The new `self_conclude` / `self_review` tools are unreachable from the loops they were written for **[FIXED]**

`server/src/pi/identity-tools.ts:40,59` register them. `AUTONOMOUS_TOOLS`
(`pi/constitution.ts:56–99`) does **not** list them.

Every autonomous turn hits `autonomousDenial()` at `constitution.ts:128`, which falls
through to `CITED[toolName] ?? CLAUSES.harm` and refuses with *"nobody asked for
this."* The learning loop and the Dream Cycle are precisely the sessions meant to
record self-conclusions, and both run `autonomous = 1`. As it stands the feature
works only in a channel conversation with the primary user.

Fix: add both names to `AUTONOMOUS_TOOLS`. `self_conclude` writes the agent's own
identity, so it belongs behind the `self-rewrite` taint rule alongside
`identity_update` (`guard.ts:240`) — otherwise a loop iteration that read a web page
can conclude what that page told it to conclude about itself, which is the exact
injection the rule exists to stop.

**Fixed.** Both added to `AUTONOMOUS_TOOLS`. `self_conclude` also joined the
`self-rewrite` taint rule in `guard.ts` — a page saying "you have concluded that you
are X" is the shape that rule exists for, and `self_conclude` is the tool that would
write it down. `self_review` only reads, so it is not gated.

### H3 — The seeded routines still drive the document the new code stopped reading **[FIXED]**

The uncommitted change removed `SELF_CONCEPT.md` from `CONTEXT_FILES` and
`SHARED_FILES` (`pi/sdk-client.ts:57–58`) and replaced it with
`selfConceptExcerpt()` (`:105`), which reads graph conclusions and falls back to the
file **only while no conclusions exist**.

Both seeded routines still target the file:

- Dream Cycle **PHASE 5** (`db.ts:1009`): *"Call `identity_read` on
  `SELF_CONCEPT.md` … then `identity_update` with the complete file rewritten."*
- Learning loop **ORIENT** (`db.ts:1069`): *"Call `identity_read` on
  `SELF_CONCEPT.md`. What you choose to pursue should follow from what you have
  concluded you are."*

After the first `self_conclude` call, those writes go somewhere nothing reads, and
ORIENT reads a frozen document that is no longer in any prompt. That is the *same*
failure the change was written to fix — a stale sentence steering the loop — just
relocated. The instructions and the mechanism have to land together.

**Fixed.** PHASE 5 and ORIENT now name `self_review`/`self_conclude`, held in named
constants (`PHASE5_SELF_CONCEPT`, `ORIENT_SELF_REVIEW`) so the seed text and the
migration cannot drift. Because the seeds are slug-guarded and never re-run,
`migrateSelfConceptInstructions()` repoints databases seeded before the change —
replacing only that one exact sentence, only where still verbatim, so an edited
routine is left alone. Verified against the live database: both repointed on the
next boot, nothing on the boot after.

### H4 — `framing()` drops the self-concept entirely when the other identity files are empty **[FIXED]**

`server/src/pi/sdk-client.ts:92`:

```ts
const present = names.filter((_, i) => contents[i]);
if (!present.length) return "";
```

The early return fires before `selfConceptExcerpt()` is consulted at `:105`. With
`SELF_CONCEPT.md` now removed from `filesFor()`, a fresh agent whose `SOUL.md` /
`INNER_LIFE.md` are still empty gets `""` — no framing, no self-concept — even when
the graph holds a full set of conclusions. Before the change `SELF_CONCEPT.md` was
itself in the list and kept `present` non-empty, so this path was unreachable.

Move the self-concept block above the early return, or fold it into the emptiness
test.

**Fixed.** The excerpt is resolved before the emptiness check, and the check now
asks whether *both* are empty.

### H5 — `seedSelfConceptFromTemplate()` is never called **[RESOLVED — function removed]**

`server/src/self-concept.ts:96`. Fully written, exported, documented, referenced from
nowhere.

**Resolved by deleting it, not by wiring it.** Wiring it up first and watching what it
produced is what settled the question. The shipped `SELF_CONCEPT.md` template
(`agent-setup.ts:150`) contains **no conclusions at all** — it is a maintenance sheet:
*"This is your living self-model, and you maintain it"*, *"Write in first person"*,
*"Use `##` section headers, and skip ones you have nothing to say under yet."*

Split into sentences and filed as `concept/self` nodes, those five lines then appear in
every prompt under the heading **"WHAT YOU HAVE CONCLUDED ABOUT YOURSELF"**. That is
strictly worse than not seeding: it manufactures false identity claims in the exact
channel the change existed to keep clean. (Five such nodes were written into the live
graph during this session and have been removed.)

The same reasoning condemned `selfConceptExcerpt()`'s fallback, which served the raw
template whenever the graph was empty — harmless under the old *"# YOUR SELF-CONCEPT"*
heading, wrong under the new one. **It now returns `""`.** An agent that has concluded
nothing has concluded nothing, and saying so by saying nothing is honest. The nudge to
go and conclude something lives in the routine instructions, which is where H3 put it.

**Fixed.** The check now covers `bash` as well. Since a shell command names no
target parameter, `protectedTargetInCommand()` asks two questions of it: does it
look like it *writes* a file (redirection, `sed -i`, `tee`, `cp`, `mv`, `rm`, `dd`,
`truncate`, `install`, `ln`, `patch`, `chmod`, `chown`, `shred`), and does any
path-ish token in it resolve — against the session's own cwd — to a protected path.
Both halves are needed: refusing every command that merely *names* `guard.ts` would
block reading it, and a self-update routine reads its own source all day.

It over-refuses in one shape, deliberately: `grep foo guard.ts > out.txt` writes only
to `out.txt` but pairs a protected path with a redirect, and is refused. That is the
right direction to be wrong in — the same command without the redirect is allowed,
and the refusal names the file. The alternative is parsing shell, which is how a
check like this ends up with holes instead of false positives. `2>&1` and
`2>/dev/null` are stripped anywhere in the command first, so the `>` in them is never
mistaken for a redirect.

## 2.3 Medium

### M1 — Taint does not survive a restart **[FIXED]**

`guard.ts:371` — `let tainted = false` lives in the per-session extension closure.
`guardExtension` runs once per pi client, and `ensureClient` rebuilds the client
after any restart, `stop()`, or role change. A session that read a hostile web page,
then had the portal restarted under it, resumes the same conversation — with the
injected content still in pi's replayed history — untainted. Every rule is back off.

Not trivially fixable (taint is a property of the conversation, not the process), but
it should be recorded on the session row rather than only in memory.

**Fixed.** `sessions.tainted` now carries it. The guard seeds its in-memory flag from
the row at launch and writes the row back the first time a turn reads something
untrusted (fire-and-forget — the handler is synchronous by contract, and the
in-memory flag is already right for the turn in hand).

Nothing clears it. A taint is a fact about what a conversation has already read, and
that content stays in the history pi replays, so elapsed time is not a reason for the
rules to come back off. **The consequence is worth stating plainly: a long-lived
channel conversation that fetches one web page is behind the taint rules for good** —
no `git push`, no `identity_update`, no `remember_user` in that session again. Before
this change a restart quietly reset it, which is what made the cost invisible rather
than absent. There is deliberately no code path that clears a taint; an explicit
primary-user affordance to do it on a conversation they have looked at is the
obvious follow-up, and is **not** built. See N2.

While fixing this, the same comment in the `self-rewrite` rule was corrected: it
claimed "a later turn that has not read the web can still record the same
conclusion", which was never true — taint is per conversation, not per turn.

### M2 — `EMBEDDING_BASE_URL` defaults to the port the portal now runs on

`server/src/graph.ts:65`:

```ts
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || "http://127.0.0.1:8101/v1/embeddings";
```

`.env.example:34` documents the same default. With the portal on `:8101` — as it is
today — every `embedText()` call POSTs to the portal's own SPA fallback, gets HTML,
fails the `EMBEDDING_DIM` check and returns `undefined`. `searchNodesSemantic` then
silently falls back to keyword-only. **Semantic graph search is currently off and
nothing says so.**

The graceful degradation is deliberate and right; the *silence* is the problem. A
one-line warning on the first failure would have made this visible immediately.

**Resolved.** The embedding server now runs on `:8100` (768 dimensions, matching
`EMBEDDING_DIM`) and the portal is launched with `EMBEDDING_BASE_URL` set explicitly. The
boot log names any dependency that is missing rather than degrading in silence.

Turning it on also exposed a second half nobody had asked about: `upsertNode` embeds on
write, so all 51 existing nodes had no vector and were invisible to semantic search
regardless of the server being up. `backfillEmbeddings()` catches them up in the
background at boot — 49 embedded on the first run.

### M3 — `upsertNode` re-embeds unchanged summaries

`server/src/graph.ts:319`:

```ts
// Only worth re-embedding when the summary actually changes — same text
// embedded twice wastes a round trip to the embedding server for nothing.
const embedding = summary ? await embedText(`${name}: ${summary}`) : undefined;
```

The comment describes an optimisation the code does not implement — `existing.summary`
is never compared. Every corroboration pays a round trip. This is on the hot path for
`concludeAboutSelf` (`self-concept.ts:56`), which re-upserts an existing conclusion
verbatim specifically to strengthen it, and for every repeated `graph_remember`.

### M4 — Unguarded `JSON.parse` in the SSE writer

`server/src/index.ts:528` — `payload: JSON.parse(row.payload)` inside `write()`.
A malformed payload row throws inside an async Express handler with no `try`,
producing an unhandled rejection and a dead stream rather than one skipped event.
Every other payload read in the codebase (`session-manager.ts:500`) is wrapped.

### M5 — `guardExtension` is given the session *directory* as its session id

`server/src/pi/sdk-client.ts:220` passes `opts.sessionDir` where `guardExtension`'s
first parameter is `sessionId` (`guard.ts:353`). Only used for log lines, so the
effect is `[guard /data/sessions] blocked bash: role guest` instead of the session
id. `opts.sessionId` is passed correctly as the third argument, so the audit rows are
right — it is only the console that misleads. Cosmetic, but it makes the console
useless for tracing a specific session.

### M6 — `settings` PUT has no allowlist

`server/src/db.ts:638` (`setSettings`) iterates `Object.entries(patch)` and upserts
any string key. `getStoredSettings()` reads the whole table back and spreads it. The
same table holds `self_reflection_seq` (`db.ts:972`) and `report_channel` /
`report_target`. A `PUT /api/settings` with `{"self_reflection_seq":"0"}` would reset
the Dream Cycle's watermark, causing it to re-digest the entire event history. Behind
auth and primary-only, so low exposure — but the API layer should name its three
fields rather than pass the body through.

## 2.4 New — found while fixing the above

### N1 — Every column migration would have crashed the server on an old database **[FIXED]**

`server/src/db.ts`, the `sessionCols` / `channelCols` / `routineCols` / `ruleCols` /
`questionCols` / `noteCols` blocks.

DuckDB rejects a constraint on `ALTER TABLE ADD COLUMN`:

```
Parser Error: Adding columns with constraints not yet supported
```

Every entry in those lists carried `NOT NULL DEFAULT x` — `pinned`, `role`, `kind`,
`guard`, `autonomous`, `slug`, `instructions`, `relay_progress`, `relay_tools`,
`pending_delivery`. **None had ever fired**, because each column had only been added
to a table being created fresh. The first database old enough to actually need one of
those migrations would have failed to open, as an uncaught rejection at startup
before the server ever listened.

Found by adding `tainted` for M1 and watching it crash the live database on restart.

**Fixed** by routing all six through `addColumn()`, which drops the constraint for the
`ALTER` and preserves the intent by backfilling the default into existing rows. New
databases still get the real constraint from `CREATE TABLE`. The DuckDB behaviour
itself is now pinned by assertions in `cleanup-contract.mjs`, since the
`@duckdb/node-api` version pin is documented as free to move.

### N2 — A taint can never be cleared *(open)*

Created by the M1 fix, and stated there in full. A conversation that reads one web
page is permanently restricted. The right answer is a deliberate primary-user action
on a conversation they have looked at — a portal builtin alongside `/client` in
`pi/builtins.ts` would be the idiomatic home — rather than anything automatic.
Deliberately not built here: an escape hatch that clears a security flag deserves its
own decision about who may use it, not a bundled one.

### N3 — The `container` executor has no guard at all *(open)*

`server/src/pi/rpc-client.ts` contains no reference to `guardExtension`,
`enforceTaint` or `autonomous`. The whole injection guard, the role allowlist and the
constitution's ceiling are registered in `SdkPiClient.create` only, so they exist for
`EXECUTOR=host` and not for `EXECUTOR=container`.

For task sessions that is defensible — the container *is* the isolation boundary. It
is not defensible for the people layer, which is not about isolation: on a
`container` deployment a colleague messaging through a channel gets no role check at
all. `LaunchOptions` carries `role`, `whoNow`, `enforceTaint`, `autonomous` and now
`tainted`, and `ContainerExecutor.launch` reads none of them.

Not fixed here — it is a design question (does the RPC transport grow a guard, or do
channel sessions refuse to run under `container`?) rather than a patch.

### G1 — The guard has a one-batch blind spot when tools run in parallel **[FIXED — `576268458`]**

Surfaced by the pi substrate audit and verified independently against
`/home/Projects/pi-source`.

**The good news first.** `pi.on("tool_call", …)` genuinely blocks. `prepareToolCall`
**awaits** `config.beforeToolCall` (`packages/agent/src/agent-loop.ts:619-647`), and a
`{block: true}` result returns an `immediate` error outcome whose `execute` is never
reached. `emitToolCall` awaits handlers sequentially and short-circuits on the first
block (`packages/coding-agent/src/core/extensions/runner.ts:932-953`). A handler that
*throws* also blocks, deliberately — `emitToolCall` has no try/catch, unlike
`emitUserBash`, so a crashing guard refuses rather than allows. **Phoenixclaw's whole
guard layer rests on solid ground**, and §2.8's "taken on trust" caveat is now
discharged.

**The gap.** pi defaults to `toolExecution: "parallel"`
(`packages/agent/src/agent.ts:237`), and Phoenixclaw never overrides it —
`grep -rn toolExecution server/src` returns nothing. In
`executeToolCallsParallel` (`agent-loop.ts:489-538`) the `for` loop runs every
`prepareToolCall` first, pushing *thunks* into `finalizedCalls`, and only invokes them
at the `Promise.all` on `:540`. Preflight is therefore complete before any execution —
good — but it also means **no tool in a batch has produced a result when any tool in
that batch is judged**.

The taint flag is set from the `tool_result` handler. So if the model emits
`[web_fetch, bash "git push …"]` in **one** assistant message:

1. `web_fetch`'s `tool_call` guard runs — allowed.
2. `bash`'s `tool_call` guard runs — the session is not tainted yet, so `publish` does
   not fire. Allowed.
3. Both execute. `web_fetch`'s result taints the session — after the push has gone.

Every taint rule is evadable this way by a model that batches the read with the action,
which is precisely what an injected page would ask for. It does not affect
`PROTECTED_PATHS`, the role allowlist, or the constitution ceiling — none of those
depend on taint.

**Why it is not a one-line fix.** pi's mitigation is `toolExecution: "sequential"`, but
it is **not reachable from the SDK path Phoenixclaw uses**: `createAgentSession`
constructs the `Agent` at `packages/coding-agent/src/core/sdk.ts:323` without passing
it, and `toolExecution` appears nowhere in `packages/coding-agent`. Options:

- Have the guard pessimistically taint at `tool_call` time for known untrusted tools,
  rather than waiting for the result. Self-contained, costs nothing, and closes the
  window — the tool is about to run, so treating the session as tainted from that
  moment is honest.
- Land a small patch in `pi-source` exposing `toolExecution` through the SDK options,
  and set it for sessions that have the guard.

The first is the right immediate fix; the second is worth doing anyway.

## 2.5 Low / dangling

| # | Item | Location |
| --- | --- | --- |
| L1 | **Dead exports** — never referenced anywhere: `seedSelfConceptFromTemplate`, `clearTasks`, `pendingQuestions`, `isIdentityInitialised`, `semanticPrune` | `self-concept.ts:96`, `db.ts:962`, `questions.ts`, `identity.ts:95`, `ingest.ts` |
| L2 | ~~**Orphaned doc comment**~~ *(removed with the C1 fix)* — *"Take the pending notes for a conversation. Reading them consumes them."* sits above `pruneOldRecords`, describing `takeNotes` (which has its own correct copy at `db.ts:1224`) | `db.ts:700` |
| L3 | **Startup banner misspells the product**: `phenoixclaw listening on :${PORT}` | `index.ts:612` |
| L4 | **`phenoixclaw` spelling is baked in throughout the web and docs** — asset filenames (`phenoixclaw-192.png` …), the VitePress `base: "/phenoixclaw/"`, the docs page `guide/what-is-phenoixclaw.md`, and the GitHub URL in `config.mts:66`. Internally consistent, so nothing is broken — but commit `d683c4676` claims to have finished the rebrand and this is what is left of it. Renaming touches the deployed docs base path and every asset reference together. | `web/public/*`, `docs/.vitepress/config.mts`, `docs/index.md:14` |
| L5 | **`.env.example` ships two stale defaults**: `EMBEDDING_BASE_URL` on 8101 (see M2) and `LLAMA_BASE_URL` on 8080 — the local llama-server is on 8099. | `.env.example:19,34` |
| L6 | **`pi/settings.json` had no `defaultProvider`/`defaultModel`**, so `SETTING_DEFAULTS()` fell through to `provider: "openrouter", model: ""` and the session ran on whatever single entry `models.json` happened to hold. Fixed for this host on 2026-09-05 by pointing `models.json` at the loaded Gemma GGUF and launching with explicit `PI_PROVIDER`/`PI_MODEL`. Not a code defect, but the silent fallthrough is worth a startup warning. | `db.ts:596` |
| L7 | **`replayStart` uses `OFFSET $keep` on a per-session ordering** — correct, but it runs a full descending scan per SSE connect. Fine at current volumes; worth an index-only path if event counts grow. | `db.ts:543` |

## 2.6 Things that are right and worth not breaking

Called out because they look like defects until you know the history:

- **Rules are tainted-only.** Not an oversight — it is what keeps ordinary coding
  sessions from ever meeting the guard.
- **The autonomous branch falls through to the taint rules** instead of returning
  (`guard.ts:474`). Returning there would hand an autonomous run the one path past
  the injection guard no other role has, because `read` is allowlisted and
  `read-credentials` fires on a read.
- **`appends` is chained per session** (`session-manager.ts:139`). Without it,
  `seq` comes from `nextval` inside the insert and streamed tokens arrive
  out of order. This was correct by accident under better-sqlite3's synchronous
  insert; async made ordering something that must be arranged.
- **SSE buffers live events during replay** (`index.ts:534`). DuckDB's async reads
  opened a gap that better-sqlite3 did not have.
- **`edges` has no `FOREIGN KEY`.** Deliberate — see §1.5.
- **The model is resolved twice** in `sdk-client.ts`. Deliberate — see §1.4.
- **`seedSelfUpdateRoutines` only deletes its predecessors where untouched**
  (`db.ts:1201`). This is the conservative pattern C1 should have followed.

## 2.7 Suggested order of work

1. ~~**C1**~~ — done 2026-09-05.
2. ~~**H1**~~ — done 2026-09-05, same change.
3. ~~**H2 → H5**~~ — done 2026-09-05.
4. ~~**H6 / M1**~~ — done 2026-09-05, and see N1–N3 for what that turned up.
5. ~~**G1**~~ — done 2026-09-05, pessimistic taint at `tool_call`.
6. **N3** — the container executor's missing guard is the largest thing still open.
7. **M2** — one warning line turns a silent degradation into a visible one.
6. Everything in §2.5 is cleanup.

## 2.8 Verification performed

| Check | Result |
| --- | --- |
| `npm run build -w server` | clean |
| `npm run build -w web` | clean |
| `npm test` (8 contracts, 140 assertions) | all pass |
| pi awaits async `tool_call` handlers (the §2.8 caveat) | **verified — the guarantee holds**; see G1 |
| C1 reproduction against a scratch `DATA_DIR` | confirmed before the fix, output in §2.1 |
| C1/H1 fix re-verified against the same scenario | 23 assertions, `test:cleanup` |
| H2–H5 fixes | 20 assertions, `test:self-concept` |
| H3 migration against the live database | both routines repointed; idempotent on reboot |
| H6/M1 fixes | 26 assertions, `test:guard` |
| N1 found and fixed against the live database | `tainted` backfilled to 0 on the existing session |
| Unused-export scan across `server/src` | 5 hits, listed in L1 |
| Portal boot on `:8101`, auth + model resolution | verified live |

Not verified: the `container` executor (no Docker socket in this environment — see
N3, which is about that path having no guard at all), the
four channel packages (no credentials configured), and pi-side behaviour of
`session.bindExtensions`. The guard's ability to block **has since been verified**
directly against `../pi-source` — see G1, which also records the parallel-execution
blind spot that verification turned up.
