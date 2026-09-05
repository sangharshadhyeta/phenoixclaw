<p align="center">
  <img src="assets/logo.png" alt="Phenoixclaw" width="140">
</p>

<h1 align="center">🐦‍🔥 Phenoixclaw</h1>

<p align="center">
  A web front end for the <a href="https://github.com/earendil-works/pi">pi coding agent</a>, built to be
  left alone.<br>
  <strong>Give it a task, close the browser, come back later and read what it did.</strong>
</p>

<p align="center">
  <a href="./docs/index.md">Documentation</a> ·
  <a href="./docs/guide/deploying.md">Deploying</a> ·
  <a href="./docs/channels/writing-a-channel.md">Write a channel</a>
</p>

---

Runs are owned by the server, not by your tab. Every event pi emits is appended to a log, so
reconnecting replays exactly what you missed and then continues live.

A fresh session starts at **roughly 6.2k tokens** of system context — the agent's identity and
memory, its tool schemas, and a one-line listing of every installed skill. Skill bodies are read
when the agent reaches for one, not loaded up front. Measured rather than budgeted: it was 3.8k
before the memory, planning and web tools landed, and every tool's schema is in the prompt from
the first token whether or not it is ever called. Which is why tools that are *about the agent
itself* — reading and rewriting its identity, reflecting over its own memory — are given to
conversations with the agent and not to a session opened against your repository. It grows with
what you install, too: each MCP server registered as direct tools adds 150–300 tokens per tool.

## Quick start

```bash
cp .env.example .env      # set PORTAL_PASSWORD, SEARXNG_SECRET and your provider key
docker compose up -d --build
```

That brings up two containers: the portal, and a **SearXNG** for the agent to
search with. Search is bundled rather than left to you because every hosted
alternative wants a commercial API key, and an agent that searches on a loop is
exactly the workload those meter — this way the queries stay on your machine
and cost nothing. It listens on the loopback interface only.

On a host with no container runtime, install it directly instead:

```bash
sudo ./scripts/install-searxng.sh    # then set SEARXNG_URL=http://127.0.0.1:8888
```

It fetches its own Python — most distributions still ship 3.9 and SearXNG needs
3.10 or newer — and leaves a systemd service behind.

Then open `http://<host>:4100`.

The container uses host networking, so pi and its extensions reach services on
the box at `127.0.0.1` — a llama.cpp server on `:8080`, for example — exactly as
they would outside a container.

## How it works

```
Browser ──SSE (replay + tail)──▶ portal ──▶ pi (SDK, in process)
                                    │
                                    └─▶ DuckDB: sessions + full event log + knowledge graph
```

The browser never drives the agent. Submitting a prompt returns as soon as pi *accepts* it;
the run continues server-side. The client reconnects with the last event id it saw
(`?since=`), so nothing is lost and nothing is duplicated.

## It doesn't stop when you leave

Two schedules fire on quiet rather than on a clock, so the agent keeps working when nothing
else is going on and yields the moment you show up.

- **Learning loop** (`@continuous`) — orients from its own `SELF_CONCEPT.md`, picks one thread
  worth pursuing, plans it, works a step, and *replans the rest from what it actually found*
  rather than from what it guessed. Its plan is visible in the session, and it never finishes:
  what one iteration leaves undone the next picks up.
- **Dream Cycle** (`@idle`) — the occasional deep pass. Digests what has happened, folds it into
  the knowledge graph, reflects across it, and rewrites `SELF_CONCEPT.md` and `INNER_LIFE.md`.
  Which is what steers the loop, so the two feed each other.

Everything either of them does is mirrored into the agent's own conversation as it happens —
you watch it think, and typing interrupts it and takes over. Its own working context stays
separate, so its inner monologue never crowds out yours.

## What bounds it

`CONSTITUTION.md` used to be prose the model was shown. It is now enforced: a turn nobody asked
for is held to an allowlist — read, search, its own memory and identity, its own plan, and asking
you. No shell, no editing files, no scheduling. Refusals cite the clause that stopped them, and
every autonomous call is recorded in **Audit**, not just the refused ones.

Reading the open web taints a turn, which closes `identity_update`, `skill_write` and
`remember_user` for the rest of it. So the agent can learn from what it reads and cannot let what
it reads rewrite who it is.

## What it remembers

A knowledge graph in DuckDB, with hybrid keyword + embedding search. Re-observing something
raises its confidence rather than overwriting it. Its identity documents live there too, so a
task session working in your repo knows who it is — which a file in a home directory could never
tell it. Facts scoped to a project stay there; what it knows about you and its own skills travel
everywhere.

## Execution modes

| `EXECUTOR` | What it does |
|---|---|
| `host` (default) | pi runs inside the portal container, working directly on the repos mounted at `/projects`. Fast, real git, full access to those directories. |
| `container` | Each task gets its own container with only its project mounted, dropped capabilities, `no-new-privileges`, and memory/CPU/PID caps. Needs the Docker socket mount. |

pi has **no approval prompts** — by design it runs with the permissions of its process
("real isolation needs to come from the OS or a container boundary"). That is what makes
unattended runs possible, and also why `PORTAL_PASSWORD` is required and why the portal
should stay on Tailscale/LAN rather than the public internet.

## Config panel

The **Config** button in a task opens the web equivalent of pi's TUI slash commands, in three tabs:

- **Session** — model (searchable across the whole provider catalogue), thinking level, live
  context usage / tokens / cost, auto-compaction toggle, and compact-now. Read from the running
  pi process, so it reflects what that session is actually using.
- **Global** — provider, default model and default thinking level applied to every **newly
  started** session. Stored in the portal database, so they outlive restarts and override the
  env defaults. Running sessions keep their own settings.
- **Packages** — install, remove and update pi packages (extensions, skills, prompts, themes)
  from npm, git, a URL or a path. They install under a persistent home directory, so they
  survive container rebuilds.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORTAL_PASSWORD` | — | **Required.** Shared password for the UI. |
| `PORTAL_SECRET` | random | HMAC key for the auth cookie. Set it so logins survive restarts. |
| `WORKSPACES_DIR` | `/root/repos` | Host directory holding the workspaces pi may work in. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_PROVIDER` / `PI_MODEL` | `openrouter` / `anthropic/claude-sonnet-5` | Passed through to pi. |
| `OPENROUTER_API_KEY` etc. | — | Provider credentials, forwarded to pi. |
| `TASK_MEMORY_MB` / `TASK_CPUS` / `TASK_PIDS_LIMIT` | `2048` / `2` / `512` | Per-task caps in `container` mode. |
| `SEARXNG_SECRET` | — | **Required for web search.** `openssl rand -hex 32`. SearXNG will not start without it. |
| `SEARXNG_PORT` / `SEARXNG_URL` | `8888` / the bundled instance | Where search lives. Point `SEARXNG_URL` elsewhere to use a SearXNG you already run. |
| `UNTRUSTED_TOOLS` | — | Extra tool names whose output is treated as untrusted — set it when installing a package that reads the outside world. |

## Sessions and workspaces

A **workspace** is a folder pi works in; a **session** is a conversation against one.
Creating a session defaults to making a fresh workspace — name it however you like and the
folder is slugified (`"Cool Project"` becomes `cool-project`), with the session taking that
same name. Pick an existing workspace from the dropdown to continue in one you already have.

Each session has its own pi conversation, workspace, and status. The sidebar shows
them all with a live status dot: running, idle, error, or **interrupted** — meaning the
server restarted while that task was mid-run. Sessions are marked interrupted rather than
left spinning forever; sending another message resumes the conversation.

## Limitations

- A session does not survive a **portal restart**, only a browser disconnect. pi persists its
  own session files, so the conversation is intact and can be continued, but the in-flight
  run stops.
- Two sessions pointed at the same workspace in `host` mode will edit the same working tree.
  Use `container` mode or separate workspaces if you want to run those in parallel.
- The constitution's allowlist is enforced under the `host` executor only. `container` speaks
  RPC and never loads these extensions.
- Untrusted-source detection is a list of tool names. A pi package installed through **Packages**
  registers whatever names it likes, so anything that reads the outside world under a name the
  guard has not heard of must be named in `UNTRUSTED_TOOLS` — otherwise its output arrives
  unwrapped and the injection guard is off for exactly the content it exists for.
- The loop is only as good as what it orients from. Until you run the setup wizard,
  `SELF_CONCEPT.md` is empty and it is reasoning from nothing.

## Tests

```bash
npm test             # graph, pruner and web-reader contracts — 42 assertions
```

Ported from BirdClaw's own suite. They use a real DuckDB file on purpose: the three bugs they
caught — a node that froze once it had an edge, a graph extension crashing the process from a
background thread, and a write-ahead log that bricked the database on restart — are all invisible
to `tsc` and all survive a mock.

## Documentation

Full docs live in `docs/` and are a VitePress site.

```bash
npm run docs         # dev server
npm run docs:build   # static build into docs/.vitepress/dist
```
