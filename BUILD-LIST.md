# Phoenixclaw — Consolidated Build List

Assembled 2026-09-05 from four independent audits plus the code review in
`ARCHITECTURE-AND-REVIEW.md`.

**The framing this list is built on:** pi is the *substrate*. BirdClaw and Sisyphean are
*finished proofs-of-concept whose features are the specification* — including BirdClaw's
UI. Phoenixclaw is the delivery. So "missing" means missing from the product, and
anything pi already provides never reaches this list.

| Source | Scope | Features | Report |
| --- | --- | --- | --- |
| BirdClaw | `birdclaw/` — agent, memory, tools, llm, gateway | 78 | `inventory-birdclaw.md` |
| Sisyphean | `Sisyphean/engine/` — graph, dream cycle, translation | 88 | `inventory-sisyphean.md` |
| BirdClaw UI | `birdclaw/tui/` + `web/` + `tray.py` | 39 surfaces | `inventory-ui.md` |
| pi substrate | `pi-source/packages/` | — | `inventory-pi.md` |

Reports live in `/root/.claude/jobs/74e19fc7/tmp/`. IDs below are theirs, so every row
is traceable back to its evidence.

---

## The substrate filter — already free, do not build

pi ships these. A naive reading of the two POCs would put every one of them on a
backlog; none belong here.

- **The agent loop, streaming, abort, idle detection** — subsumes BirdClaw's
  `agent/loop.py`, `orchestrator.py`.
- **Seven built-in tools** — `read, bash, edit, write, grep, find, ls`
  (`tools/index.ts:83-84`). Subsumes BirdClaw's `tools/files.py`, `bash.py`,
  `line_search.py`, `code_index.py`.
- **The LLM client, ~40 providers, cost/context catalogue, OAuth, retry** — subsumes
  BirdClaw's entire `llm/` package: `client.py`, `adapter.py`, `model_profile.py`.
- **Auto-compaction and context accounting** — subsumes `memory/compact.py`.
- **Versioned JSONL session trees with fork/branch/resume** — subsumes
  `memory/history.py`, `session_log.py`.
- **Skills with lazy bodies** — subsumes `skills/loader.py`.
- **A TUI** — BirdClaw's `tui/` is 4,292 lines pi already has. Phoenixclaw's job is the
  *browser*, and BirdClaw's TUI is the design spec for that, not code to port.

**Three things pi does NOT ship**, contrary to reasonable assumption: **MCP** (Phoenixclaw's
comes from the third-party `pi-mcp-adapter`), **web tools**, and **any permission system or
sandbox** — the last by explicit design, which is why the guard exists at all.

---

## The governing principle: verify, don't recall

**Stated after the audits landed, and it reprioritises them.** Sisyphean's epistemics are
the intended model for how a request is served:

- **The graph is not an authority.** It records what the agent knows *and where each
  belief came from*. A remembered fact is a lead to re-check, not an answer to give.
  Anything load-bearing is verified against ground truth — the web, the filesystem, the
  repository — at the point of use.
- **Computation goes to a tool, never to the model.** `2 + 2` belongs in `bash`. A
  computed answer is deterministic; a generated one is a guess that is usually right,
  which is worse than a guess that is obviously wrong.

This is one principle twice: **prefer ground truth over recall, deterministic over
generated.**

It changes the shape of Tier 2. Provenance (T2-3) stops being bookkeeping and becomes the
foundation — you cannot re-verify a claim whose source you did not keep. Decay (T2-1)
stops being hygiene and becomes correctness: an unverifiable belief must lose standing
over time rather than harden. And three rows the Sisyphean audit dismissed as
small-model scaffolding come back:

| Row | Audit called it | Actually |
| --- | --- | --- |
| **SIS-14** `faithfulness()` | P2 — nice-to-have | **P1** — scoring an extracted claim against its source text *is* the verification step, and it sets the initial confidence honestly |
| **SIS-63** calc-skill / tool-preference guards | P3 — "corrects a 0.6B model mis-selecting a tool" | **P1** — routing computation to a tool is the design, not a workaround for a weak model |
| **SIS-57** search fallback tier | P2 | **P1** — if verification depends on reachable search, a single unreachable SearXNG silently turns verification back into recall |

**The guard already supports this, by design.** Reading the web taints a session, and a
tainted session may still call `graph_remember` — but not `identity_update`,
`skill_write`, `remember_user` or `self_conclude`. That is exactly the right split for
verify-then-record: learn freely from what you read, but never let what you read rewrite
who you are. No change needed; worth knowing it was not an accident.

---

## Tier 0 — Security and correctness

Nothing else should start before these. Four of the six were found by the audits, not by
the review, and two are more serious than anything on any feature list.

| # | Item | Source | Effort | Why it is Tier 0 |
| --- | --- | --- | --- | --- |
| **T0-1** | **Project trust defaults to *trusted*** | `inventory-pi.md` §11 | S | `settings-manager.ts:358` — `options.projectTrusted ?? true`, and Phoenixclaw never passes it. A task session opened against any repository loads that repo's `.pi/extensions` and `.pi/SYSTEM.md` **as trusted**: arbitrary code, in-process, alongside the guard. Cloning a hostile repo and pointing a session at it is full compromise. Fix: pass `projectTrusted` from `resolveProjectTrust` (PI-UNUSED-01). |
| **T0-2** | **The guard's parallel blind spot** | Review G1 | S | pi defaults to `toolExecution: "parallel"`. Every `tool_call` guard in a batch runs before any `tool_result`, so `[web_fetch, bash "git push"]` in one assistant message evades every taint rule. Verified in `agent-loop.ts:489-538`. pi's own switch is unreachable from the SDK path, so the fix is to taint pessimistically at `tool_call` time for untrusted tools. |
| **T0-3** | **The `container` executor registers no guard** | Review N3 | L | `rpc-client.ts` has no `guardExtension`, no `enforceTaint`, no roles. On `EXECUTOR=container` a colleague messaging through a channel gets **no role check at all**. Isolation answers the task case; it does not answer the people case. Design decision needed: does RPC grow a guard, or do channel sessions refuse to run under `container`? |
| **T0-4** | **Self-update has no safety envelope** | BC-12 | M | The seeded `self-update` routine edits Phoenixclaw's and pi's own source with no snapshot, no test-gated keep-vs-revert, no restore. BirdClaw had all three. It ships disabled, which is the only reason this is not already a live hazard. |
| **T0-5** | **Restrict the tool set structurally** | PI-UNUSED-02 | S | pi accepts `tools`/`excludeTools` at session construction. Today the guard's `READ_ONLY` allowlist names `grep`, `find`, `ls` — **which pi does not register by default**, so a colleague effectively has `read` alone, while `write`/`edit`/`bash` are registered for every session and refused only per-call. Make the limit structural instead of advisory. |
| **T0-6** | **No ceiling on an autonomous run** | BC-09 | M | `@continuous` and `@idle` routines are unbounded and unattended. Nothing counts turns or tokens; a pathological loop runs until someone notices. BirdClaw force-advanced on budget exhaustion. |

---

## Tier 1 — The single-conversation interface

**This is a design decision already taken:** one chat surface carrying both the agent's
inner monologue and your conversation; tasks separated underneath but shown together;
personality carried by the interface, not by each task.

The architecture already agrees. `mirror.ts` states the principle — *"One conversation,
nothing hidden"* — and, crucially, the mechanism that makes it affordable:

> the portal's `events` table is a display and audit log, not the model's memory — pi
> keeps its own session file for that. **Writing a row here shows the user something; it
> puts nothing into anybody's context window. Visibility is free; sharing a context is
> not.**

So: **unify the display, keep the contexts separate.** Three hard constraints make the
separation non-negotiable — pi binds a session to one cwd; a shared window would compact
the user's conversation away to fit dream-cycle output; and taint is per-conversation, so
one merged session would put the whole relationship behind the taint rules after a single
`web_fetch`.

| # | Item | Source | Effort | Server? |
| --- | --- | --- | --- | --- |
| **T1-1** | Mirror **task** sessions into the main conversation, not only routines — `mirrorToMain` is gated on `routineOf`, so task work is invisible today | mirror.ts | M | yes |
| **T1-2** | Make the main conversation (`browser:main`) the landing view; demote explicit session creation from the primary interaction | UI-01 | M | no |
| **T1-3** | Collapsible per-task threads within the single stream — a flat merge would bury the conversation, which `mirror.ts` calls "hiding by volume" | UI-01/03 | M | no |
| **T1-4** | Re-budget what gets mirrored now that tasks mirror too: milestones, not tokens | mirror.ts | S | yes |

**One correction to the stated intent.** "Each task does not maintain the personality" —
split that. A task session should still *carry* identity (otherwise it introduces itself
as bare "pi", the exact bug that moved identity into the graph) but must not *change* it.
Read yes, write no — already true: `identityTools` register only when `kind !== "task"`.

---

## Tier 2 — Memory curation

The single largest cluster of genuine gaps, and the one place both POCs agree. It is
model-independent — none of it is scaffolding for a small model.

| # | Item | Source | Pri | Effort | What |
| --- | --- | --- | --- | --- | --- |
| **T2-1** | **Confidence decay** | SIS-08/29 | P0 | M | Confidence only ever rises (`graph.ts:347`), and `routine_cleanup` ages out only `episode`/`tool_cache`/`page`/`workspace_note` — never `fact` or `concept`. Every wrong belief is permanent and outranks fresher knowledge. A `@continuous` loop writes forever. |
| **T2-2** | **Semantic near-duplicate merging** | SIS-22 | P0 | M | Dedup is exact-name-only, so "Gemma model" and "the Gemma model" accumulate as distinct nodes that never merge and — per T2-1 — never fade. |
| **T2-3** | **Node provenance (`sources`)** | SIS-13 | **P0** | M | Nothing records where a fact came from. Under "verify, don't recall" this is the foundation of the whole tier: a belief whose source was not kept cannot be re-checked, only trusted. Also the only way to tell a page-derived claim from something the primary user said. |
| **T2-3b** | **Faithfulness scoring on ingest** | SIS-14 | P1 | S | Score an extracted claim's overlap against the source text and use it as the initial confidence, so a weakly-supported claim enters weak rather than at a flat 0.5. |
| **T2-3c** | **Computation routed to tools** | SIS-63 | P1 | S | Prompt-level policy plus a check: arithmetic, date maths and unit conversion go to `bash`, never to the model. |
| **T2-4** | **A correction path** | SIS-76 + UI-38 | P1 | S | Expose `removeNode` over `/api/memory` and as a graph tool. While there is no decay, this is the *only* way to unsay something. |
| **T2-5** | **Embedding cache invalidation** | SIS-11 + review M3 | P1 | S | One string comparison. `graph.ts:319` carries a comment describing exactly this optimisation and does not implement it, so every corroboration pays a round trip. |
| **T2-6** | **Isolated-node clustering** | SIS-30 | P1 | M | Nothing links orphan facts, so each research burst becomes islands reachable only by exact text match. Zero LLM calls. |
| **T2-7** | **The graph is pull-only** | SIS-20/21/25 | P1 | M | Nothing is retrieved into a prompt and nothing is written unless the agent calls a tool or `@idle` fires (10 min quiet + 3 hr gap). Derive a one-line episode node when a session goes idle — no LLM call — and inject a short `scopedSearch` block at turn start. |
| **T2-8** | **Recency in ranking** | SIS-07 + BC-25 | P1 | S | Add a freshness multiplier to `searchNodes`'s `ORDER BY score * confidence`, so stale-but-unexpired facts stop being recalled at full confidence. |
| **T2-9** | **Don't prune un-digested sessions** | BC-36 | P1 | S | Exclude sessions above `getReflectionSeq()` from `pruneOldRecords`, so the Dream Cycle never loses material it has not read. |

---

## Tier 3 — Visibility

Two live faults sit here, both invisible by construction.

| # | Item | Source | Pri | Effort | What |
| --- | --- | --- | --- | --- | --- |
| **T3-1** | **Health check** | BC-76 + UI-27b + review M2 | P1 | S | One `/api/health` probing the embedding server, local model, SearXNG and both DuckDB files. **`EMBEDDING_BASE_URL` defaults to `:8101` — the port the portal itself now occupies — so semantic graph search is silently off right now and nothing says so.** This is the item that would have caught it. |
| **T3-2** | **Token and cost tracking** | BC-62 | P1 | M | Nothing counts tokens or cost anywhere. A portal running unattended autonomous loops cannot answer "what did the learning loop cost last week", nor notice a run gone pathological. Pairs with T0-6. |
| **T3-3** | **Tool cards with results** | UI-08 | P0 (UI) | M | The single highest-value UI gap. Keep `tool_execution_end.result`, pair on `toolCallId`, render an expandable per-tool-formatted card. BirdClaw's `cards.py` is 522 lines of exactly this and it is what makes a run legible. |
| **T3-4** | **Persistent status line** | UI-02 | P1 | S | Model, context usage, cost, elapsed — promoted from composer pills into a chat header. |
| **T3-5** | **Connection indicator** | UI-27 | P1 | S | Expose EventSource open-vs-reconnecting state as a visible dot. |
| **T3-6** | **Elapsed / relative timestamps** | UI-37 | P1 | S | `+4.2s` from run start on tool rows, from stored event times. |
| **T3-7** | **Decision trace** | SIS-79/81 | P2 | M | A per-turn decision-trace table and route, so an unattended autonomous iteration can be inspected — and asserted on in a test. |
| **T3-8** | **Transcript search** | UI-19 | P1 | M | In-page regex over loaded events; a server route for cross-session history. |
| **T3-9** | **Command palette** | UI-25 | P1 | M | One ⌘K: jump to session/routine/memory/settings, run portal builtins. Subsumes UI-18 and UI-22. |
| **T3-10** | **Toasts for off-screen completions** | UI-23 | P1 | M | Especially once T1-1 lands and tasks report into the main stream. |

---

## Tier 4 — Worth doing, not urgent

`semanticPrune` is written, tested, and **never called** (BC-26 + SIS-58) — wire it into
`web_fetch`, one call site. Then: an improvement backlog so self-update works a queue
instead of rediscovering its agenda (BC-13, ~30 lines); `--network none` on container
task sessions, since the portal restricts no egress at all (BC-42); web-content
condensing before `rememberPage` (BC-29); `every:N` schedules (BC-72); a regex NER pass
over tool results (SIS-38); AST nodes into the graph (SIS-35); a memory graph
visualisation (UI-30); identity reload-from-disk when the mirror is newer (SIS-70); the
graph as a read-only MCP server (BC-53). Plus the review's own M4 (unguarded `JSON.parse`
in the SSE writer), M5 (guard logs the session *directory* as its id) and M6 (`settings`
PUT has no allowlist).

---

## Explicitly not building

Recorded so nobody re-proposes them.

- **The staged pipelines.** BirdClaw's plan→stage-queue→subtask-planner→executor→verifier
  and Sisyphean's whole `translation/` package exist to get structured behaviour out of a
  0.6B–4B model. `db.ts:1210-1215` already says why: *"a model that can already follow a
  plan does not need to be marched through one."* ~30 rows across the two reports.
- **DuckPGQ traversal** — removed; it raised an internal assertion from a background
  thread and took the portal down. Plain SQL replaced it.
- **Approval cards / plan-approval mode** — pi has no approval prompts by design; guard +
  roles + audit replace them.
- **A tool router** (BC-11) — would bust the prompt cache every turn to solve a problem a
  capable model does not have.
- **Soul-section and policy routing** (SIS-68/69) — serving one slice of personality per
  query makes the agent's voice vary by query.
- **Context compressor, context router, recall heuristics** (SIS-44/45/46) — all exist to
  fit a document into an 8K window.
- **A web shell** (BC-75, UI-15/33) — materially worse on a multi-user portal with
  unrestricted egress. Security decision first, if ever.
- **System tray** (UI-39) — Docker/systemd owns process lifecycle.

---

## Suggested order

1. **T0-1** — one line, and it is arbitrary code execution.
2. **T0-2**, **T0-5** — both small, both close a gap the guard claims to cover.
3. **T2-1 + T2-2 + T2-4** together — decay, dedup and a correction path are one coherent
   change to the graph's curation layer, and the loop is writing into it right now.
4. **T3-1** — one route that makes two current faults visible.
5. **T1-1 → T1-4** — the interface change, once the memory it displays is trustworthy.
6. **T0-3**, **T0-4**, **T0-6** — the three that need a design decision before code.

## Cross-validation

Where two independent audits found the same thing, confidence is high: the dead
`semanticPrune` (BirdClaw + Sisyphean), the embedding-cache comment that describes an
unimplemented optimisation (Sisyphean + review M3), the silently-dead semantic search
(Sisyphean + BirdClaw + review M2), and the missing guard on the container executor
(BirdClaw's closing note + review N3).

Every `BUILT`/`PARTIAL` claim behind this list carries a `file:line` the auditing agent
opened. T0-1, T0-2 and T0-5 were re-verified by hand against `pi-source` before being
promoted to Tier 0.
