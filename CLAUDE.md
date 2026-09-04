# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Phoenixclaw is a web portal around the [pi coding agent](https://github.com/earendil-works/pi):
an Express + React app that owns long-running agent sessions server-side so a browser can
disconnect and reconnect without losing a run. Internal package names are still `pithagoras`
(npm workspace names, the `pithagoras.channel` marker, docs prose) — that is the old name, not a
separate project. Don't rename them casually; the channel marker is a load-bearing public contract.

`docs/` is the real specification and explains *why* most of the odd decisions exist. Read
`docs/reference/architecture.md` before any non-trivial server change; `docs/guide/security.md`
and `docs/people/` before touching the guard or roles.

## Commands

```bash
npm install                # root; npm workspaces (server, web, docs)
npm run dev:server         # tsx watch, :4100
npm run dev:web            # vite, :5190, proxies /api -> :4100
npm run build              # tsc -p server + tsc -b && vite build for web
npm start                  # node server/dist/index.js (needs a prior build)
npm run docs               # VitePress dev server
npm run docs:build

docker compose up -d --build   # the deployed path; needs .env (see .env.example)
```

`npm test` runs both contracts — the knowledge graph's (`server/test/graph-contract.mjs`, ported
from BirdClaw's `TestKnowledgeGraph`) and the pruner's (`server/test/prune-contract.mjs`). They are
the only tests; there is no linter or formatter.
Typechecking is the other gate: `npm run build -w server` and `npm run build -w web` (the web build
typechecks via `tsc -b`). Run all three after server changes — the graph contract catches things
`tsc` cannot, which is why it exists.

`server/package.json` depends on `@earendil-works/pi-coding-agent` via `file:../../pi-source/packages/coding-agent`
— a **sibling checkout** of pi, expected at `../pi-source`. Local dev breaks without it. The Docker
image instead installs pi from npm.

## Architecture

### Fire-and-forget runs

The invariant everything else follows from: a run belongs to the server, not to a request.
`POST /api/sessions/:id/prompt` returns as soon as pi accepts the message. Every pi event is
appended to the DuckDB `events` table with a monotonic `seq`; `GET /api/sessions/:id/events` (SSE)
replays from the client's `?since=` cursor and then tails. Preserve this when adding features —
anything that only exists in memory for the duration of a request is a regression.

The exception: extension dialogs are emitted with a **negative `seq`** and never persisted, so a
reload can't reopen a menu whose extension stopped waiting long ago.

### Layout

- `server/src/index.ts` — Express app; inline routes for auth/settings/workspaces/sessions, then
  mounts the routers in `server/src/api/*` (packages, extensions, channels, routines, skills, mcp, people).
- `server/src/session-manager.ts` — the lifecycle: lazily starts pi per session, tracks status,
  fans events out to SSE and to the event log.
- `server/src/executors/index.ts` — `host` (pi in-process via its SDK, `pi/sdk-client.ts`) vs
  `container` (throwaway Docker container speaking JSONL RPC, `pi/rpc-client.ts`). Both satisfy
  `PiClient` (`pi/types.ts`); nothing else in the portal branches on which is active. Slash commands
  from extensions only work under `host`.
- `server/src/pi/*` — everything injected *into* a pi session: the guard, and the tool sets
  (`routine-tools`, `graph-tools`, `identity-tools`, `report-tool`, `ask-primary`, `memory-digest`).
  Which tools a session gets depends on its kind — task sessions deliberately get no routine tools.
- `server/src/db.ts` — `portal.duckdb`, one connection, migrations by `ALTER TABLE` plus a check
  against `information_schema.columns` (DuckDB has no `PRAGMA table_info`). Never recreate tables;
  upgrades must keep existing sessions and their history.
- `server/src/graph.ts` — a *separate* `graph.duckdb` knowledge graph (nodes/edges, hybrid FTS +
  embedding search, DuckPGQ traversal).
- `server/src/channels/` — loader + supervisor for channel packages; `channels/` holds the four
  builtin reference implementations (telegram, slack, discord, webhook).
- `web/src/` — React + react-router + Tailwind. Every meaningful view has a URL (see `App.tsx`),
  with an SPA fallback on the server. State is polled every 5s; the open session also streams SSE.
  `web/src/api.ts` is the single API client.

### Session kinds

`task` (a workspace you created), `agent` (arrived through a channel, cwd = agent home), and
`routine` (owned by a schedule). The kind decides tool availability and context files; check
`SessionRow.kind` rather than inferring from cwd.

### Identity lives in the graph, not on disk

`SOUL.md`, `PrimaryUser.md`, `MEMORY.md`, `SELF_CONCEPT.md`, `INNER_LIFE.md` are `anchor` nodes in
`graph.duckdb` (`server/src/identity.ts`); disk is a human-readable mirror only. This is what lets a
task session — whose cwd is the workspace, not agent home — still know who it is. Read them through
`readIdentity()`, never with `readFileSync`.

`CONSTITUTION.md` is the one deliberate exception: disk-only, human-edited, injected only into
self-update routine sessions, and protected by `PROTECTED_PATHS` in `pi/guard.ts`. Keep it out of the
graph and out of ordinary session context.

Role gates which files load: `PrimaryUser.md` and `MEMORY.md` are the primary user's only; the rest
travel to every conversation (`filesFor()` in `pi/sdk-client.ts`).

### Two security layers, both in `pi/guard.ts`

1. **Taint / injection guard.** Output from sources carrying other people's words is wrapped in
   `<<<untrusted:...>>>` markers with a **random per-result id** (a fixed one would be a password
   printed in a public repo). Reading untrusted content taints the session; six rules
   (pipe-to-shell, write-to-path, upload, read-credentials, publish, persist) then refuse. Rules are
   tainted-only on purpose — ordinary coding sessions never meet them. A routine can be exempted,
   which still logs to `audit` as `allowed-by-exemption`.
2. **People / roles.** primary / colleague / guest / blocked, identified by platform id scoped by
   channel (`telegram:100200300`), never by display name. Colleague permissions are an **allowlist**
   (`read`, `grep`, `find`, `ls`, `ask_primary` + explicit `tool_rules`), so any tool added later
   starts outside it. Checked per tool call, because the speaker changes between turns in a group.

### Session boot order matters

In `pi/sdk-client.ts` the model is resolved **twice** — before and after `bindExtensions()` —
because extensions register their own providers, so e.g. a `llama-server` model does not exist until
extensions are bound. The `DefaultResourceLoader` needs **both** `cwd` and `agentDir`. And the stored
`pi_session_file` is reopened by path rather than calling `SessionManager.create()` (which would
start a fresh conversation) or `continueRecent()` (which guesses). Each of these has already been a
bug; see the architecture doc.

## Constraints worth knowing

- `@duckdb/node-api` is pinned to `1.4.4-r.4`. The reason was DuckPGQ, which has been removed
  (it crashed the process from a background thread); the pin is now free to move, and moving it
  wants the graph contract run afterwards.
- Never put a `FOREIGN KEY` on a table whose parent rows get updated. DuckDB rewrites `UPDATE` on a
  referenced table as delete+insert and trips its own constraint, which froze every node that had
  an edge. See the comment on `edges` in `graph.ts`.
- Migrations must be followed by `CHECKPOINT`. An `ALTER TABLE ADD COLUMN` left in the WAL cannot
  be replayed when the table has `now()` defaults, and the database then refuses to open at all.
- pi has no approval prompts by design — it runs with its process's permissions. That is why
  `PORTAL_PASSWORD` is required and why the portal is meant for Tailscale/LAN, not the public
  internet. Egress is not restricted; don't claim it is.
- Persistent state must live under `/data` (the volume): `HOME=/data/home`, `AGENT_HOME`,
  `CHANNELS_DIR`, `SESSION_DIR`, and `/data/bin` on `PATH`. Anything installed into the image
  filesystem at runtime survives a restart and then vanishes on the next rebuild.
- Comments in this codebase explain the bug a decision prevents, not what the code does. Match that
  when adding non-obvious logic, and don't strip them.
