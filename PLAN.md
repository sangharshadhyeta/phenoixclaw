# Phoenixclaw — Implementation Plan

Companion to `BUILD-LIST.md` (what to build and why) and `ARCHITECTURE-AND-REVIEW.md`
(how the system works today). This is the *how and in what order*, written against pi as
the substrate.

## Two principles everything below serves

1. **One conversation, separate contexts.** A single interface carrying the agent's inner
   monologue and your chat together; tasks separated underneath. Personality is authored
   once and carried everywhere, never accumulated per task.
2. **Verify, don't recall.** The graph indexes what is known and where it came from. Load-
   bearing claims are re-checked against ground truth at use. Computation goes to a tool.

## What "pi as substrate" means in practice

Every item below is one of three kinds. Getting this classification right is most of the
work, because the expensive mistake is building something pi already has.

| Kind | Meaning | Cost |
| --- | --- | --- |
| **[USE]** | A pi facility exists; pass an option or call an API | hours |
| **[PORTAL]** | Genuinely the portal's job; pi neither has it nor should | days |
| **[PATCH]** | Needs a change in `../pi-source`, then adoption here | days + a sibling release |

Only **two** items in this whole plan are `[PATCH]`, and both have a portal-side
workaround that ships first. That is the measure of pi being the right substrate.

---

# Phase 0 — Close the security gaps

**Goal:** every guarantee the code claims is actually enforced. Nothing else starts first;
three of these are one-line-to-one-file changes and one is arbitrary code execution.

### 0.1 Project trust `[USE]` — S ✅ `576268458`

`settings-manager.ts:358` is `options.projectTrusted ?? true` and Phoenixclaw never passes
it, so a session opened against any repo loads that repo's `.pi/extensions` and
`.pi/SYSTEM.md` **as trusted** — arbitrary code in-process, beside the guard.

- Pass `projectTrusted` into `createAgentSession` from `pi/sdk-client.ts`.
- Default **false** for `task` sessions (a workspace is somebody else's code).
- True only where the agent owns the tree: `agentHome()`, and the self-update routine's
  own checkout.
- Surface trust state in the session config API so the UI can show it.

**Done when:** a session against a repo carrying `.pi/extensions` does not load it, and a
contract asserts that.

### 0.2 Pessimistic taint `[PORTAL]` — S ✅ `576268458`

pi runs tool batches in parallel; every `tool_call` guard in a batch fires before any
`tool_result`, so `[web_fetch, bash "git push"]` in one assistant message evades every
taint rule (`agent-loop.ts:489-538`, verified).

- In `pi/guard.ts`, set `tainted` in the **`tool_call`** handler when
  `isUntrustedSource(toolName, …)` matches — not only in `tool_result`.
- Keep the `tool_result` write for the envelope and the row.
- The tool is about to run; treating the session as tainted from that moment is honest,
  and closes the window without touching throughput.

**Done when:** the guard contract gains a batch case — an untrusted call and a `publish`
in the same batch, the publish refused.

### 0.3 Structural tool limits `[USE]` — S ✅ `576268458`

pi accepts `tools` / `excludeTools` at construction. Today `write`/`edit`/`bash` are
registered for every session and refused per-call, and the guard's `READ_ONLY` allowlist
names `grep`/`find`/`ls` **which pi does not register by default** — so a colleague has
`read` alone.

- Pass an explicit tool set per session kind and role.
- Register `grep`/`find`/`ls` so the allowlist means what it says.
- Keep the per-call guard: defence in depth, and the speaker changes mid-conversation.

**Done when:** a colleague session's tool list contains only what the allowlist names.

### 0.4 Run ceilings `[PORTAL]` — M ✅ `090fa36d6`

`@continuous` and `@idle` routines are unbounded and unattended.

- Count turns and tokens per run from pi's own events; store on `sessions`.
- Abort at a configurable ceiling, record `last_status = 'budget'`, report it.
- Ships with Phase 3's cost tracking — same event plumbing, so build the meter once.

### 0.5 Self-update safety envelope `[PORTAL]` — M ✅ `6978958e1`

The routine edits Phoenixclaw's and pi's source with no snapshot and no revert.

- `git stash`-style snapshot before, build+test gate after, automatic restore on failure.
- Refuse to run on a dirty tree.
- It ships disabled; keep it disabled until this lands.

### 0.6 Container executor: decide `[PORTAL]` — L ✅ decided and implemented

`rpc-client.ts` registers no guard, so `EXECUTOR=container` has no roles and no taint.
**Decided: refuse, do not degrade.** `container` runs `task` sessions only. Channel
conversations and autonomous routines are refused at launch with a reason naming the
missing control and the way out, and the limitation is announced at boot.

The two alternatives were both worse, and in the same way — each would keep the feature
working while quietly removing a guarantee the operator had asked for. Falling back to
`host` removes the isolation they chose `container` for; running unguarded removes the
roles check and the constitution ceiling. Neither is a decision to take on somebody's
behalf at runtime, and a silently unguarded channel session is exactly what this was
opened to prevent.

A full RPC-side guard remains the answer if channels must run containerised. Nothing here
forecloses it; it just is not owed before the gap stops being silent.

**Phase 0 gate:** ✅ met — 0.1 through 0.6 complete. `npm test` is ten contracts / 174 assertions, including a
hostile-repo fixture for 0.1, batch cases for 0.2, and real git repos for 0.5.
0.4 deferred its token half to 3.3, which shares the same event plumbing.

---

# Phase 1 — Epistemics: verify, don't recall

**Goal:** the graph becomes an index with provenance rather than an oracle. This is the
phase that makes the agent's memory trustworthy, and it must precede the interface work —
an interface that surfaces untrustworthy memory more prominently is worse than one that
hides it.

### 1.1 Provenance `[PORTAL]` — M · foundation

Add `sources TEXT[]` to `nodes`, unioned on upsert. Every write path passes what produced
the claim: tool name, URL, session id, or `primary-user`.

Migration goes through `addColumn()` — DuckDB rejects constrained `ALTER`, which the
`tainted` column already proved.

**Why first:** every other item in this phase needs it. A belief whose source was not kept
can only be trusted, never re-checked.

### 1.2 Faithfulness on ingest `[PORTAL]` — S

Score an extracted claim's token overlap against its source text; use it as the initial
confidence instead of a flat 0.5. `prune.ts`'s tokeniser already does the hard part.

### 1.3 Confidence decay `[PORTAL]` — M

A pass in Dream Cycle PHASE 7: ×0.9 for `fact`/`concept` nodes untouched >30 days, floor
0.10, `anchor`/`user`/`project` exempt.

Today confidence only ever rises (`graph.ts:347`) and `routine_cleanup` never ages `fact`
or `concept`, so every wrong belief is permanent and outranks fresher knowledge. Under
"verify, don't recall" decay is not hygiene — it is what makes an unverified claim lose
standing instead of hardening.

### 1.4 Semantic dedup `[PORTAL]` — M

Embed a new node's label; merge above a similarity threshold before insert. Without it
"Gemma model" and "the Gemma model" are two nodes that never merge and — per 1.3 — never
fade. Depends on embeddings actually working, which is Phase 3's health check; until then
fall back to normalised-label matching.

### 1.5 A correction path `[PORTAL]` — S

Expose `removeNode` over `/api/memory` and as a graph tool, primary-role only. While decay
is landing this is the only way to unsay something.

### 1.6 Computation to tools `[PORTAL]` — S

Prompt-level policy: arithmetic, date maths, unit conversion go to `bash`. State it in the
identity framing so it applies to every session, and check it in a contract by asserting
the policy text is present.

### 1.7 Recency in ranking `[PORTAL]` — S

A freshness multiplier on `searchNodes`'s `ORDER BY score * confidence`, so a stale
unexpired fact stops being recalled at full strength.

### 1.8 Search fallback tier `[PORTAL]` — S

A keyless second search backend behind SearXNG, declared in `UNTRUSTED_TOOLS` so its
output is still tainted. If verification depends on reachable search, one unreachable
SearXNG silently turns verification back into recall.

### 1.9 Close the pull-only gap `[PORTAL]` — M

Nothing enters the graph unless a tool is called or `@idle` fires (10 min quiet + 3 hr
gap). Derive a one-line `episode` node when a session goes idle — no LLM call — and inject
a short `scopedSearch` block at turn start so the graph is consulted without being asked.

### 1.10 Wire up `semanticPrune` `[PORTAL]` — S

Written, tested, never called. One call site in `web_fetch`.

**Phase 1 gate:** graph contract extended — provenance survives upsert, decay moves
confidence down, dedup merges near-labels, `removeNode` is reachable. The learning loop
runs a week without the graph degrading.

---

# Phase 2 — One conversation

**Goal:** the interface becomes the continuous thread. Depends on Phase 1: this makes
memory *more* visible, so it needs to be memory worth seeing.

The mechanism is already stated in `mirror.ts` — *"Writing a row here shows the user
something; it puts nothing into anybody's context window. Visibility is free; sharing a
context is not."* **Unify the display; keep the contexts separate.**

### 2.1 Mirror task sessions `[PORTAL]` — M

`mirrorToMain` is gated on `routineOf`, so only routines mirror. Extend to `task`, tagged
with session id and title.

### 2.2 Re-budget the mirror `[PORTAL]` — S

With tasks mirroring too, "milestones not tokens" needs re-drawing: run start/end, tool
names, stated conclusions. Not deltas — `mirror.ts` calls that "hiding by volume".

### 2.3 Main conversation as the landing view `[PORTAL]` — M

`browser:main` already exists as a reserved key. Make it the default route; demote session
creation from primary interaction to an affordance inside the stream.

### 2.4 Collapsible task threads `[PORTAL]` — M

One stream, but each task's mirrored output collapsible under a header showing its
workspace and status. This is what makes "separated but shown together" legible rather
than a flat merge.

### 2.5 Keep identity read-only in tasks `[USE]` — none

Already true (`identityTools` register only when `kind !== "task"`). Documented here so it
is not "fixed" later: a task must *carry* identity — otherwise it introduces itself as
bare "pi", the bug that moved identity into the graph — but must never *change* it.

**Phase 2 gate:** a task run started from the main conversation streams its milestones
there, collapsible, while its own context stays separate — and a `web_fetch` inside it
taints only that task.

---

# Phase 3 — Make it legible

**Goal:** a run you did not watch can be understood afterwards. Two live faults are
invisible today.

### 3.1 Health check `[PORTAL]` — S · do this first

One `/api/health` probing the embedding server, local model, SearXNG and both DuckDB
files. **`EMBEDDING_BASE_URL` defaults to `:8101`, the port the portal now occupies, so
semantic search is silently off right now.** Phase 1.4 depends on embeddings working, so
this genuinely gates that.

### 3.2 Tool cards `[PORTAL]` — M · highest UI value

Keep `tool_execution_end.result`, pair on `toolCallId`, render an expandable card with
per-tool formatting (diff for edits, output for bash, hits for search). BirdClaw's
`cards.py` is 522 lines of exactly this, and it is what makes a run readable.

### 3.3 Cost and token meter `[PORTAL]` — M

Persist per-session totals from pi's events; surface in the status line. Shares plumbing
with 0.4 — build the meter once, use it for both the ceiling and the display.

### 3.4 Status line, connection dot, elapsed times `[PORTAL]` — S each

Model, context, cost, elapsed in a persistent header; EventSource state as a visible dot;
`+4.2s` on tool rows.

### 3.5 Transcript search and ⌘K palette `[PORTAL]` — M each

In-page regex now, a server route for cross-session history later. One palette for jump-to
and portal builtins.

### 3.6 Decision trace `[PORTAL]` — M

A per-turn trace table and route, so an unattended autonomous iteration can be inspected
and asserted on in a test.

**Phase 3 gate:** a dependency outage is visible within one page load; a finished run reads
back without opening the database.

---

# The two pi patches

Both have a portal-side workaround shipping first, so neither blocks anything.

| # | Patch | Why | Workaround until then |
| --- | --- | --- | --- |
| **P-1** | Expose `toolExecution` through `createAgentSession` | `sdk.ts:323` constructs the `Agent` without it, so `"sequential"` is unreachable from the SDK. It is the structural fix for the batch blind spot. | 0.2 pessimistic taint |
| **P-2** | MCP support upstream | pi ships none; Phoenixclaw's comes from third-party `pi-mcp-adapter`, an unowned dependency in the trust path | keep the adapter, declare its tools in `UNTRUSTED_TOOLS` |

Both are small, upstreamable, and worth offering back rather than carrying as local
forks.

---

# Sequencing

```
Phase 0  ──────────────▶  security; nothing else starts first
   │
   ├── 3.1 health ──────▶  pulled forward: 1.4 needs embeddings to work
   │
Phase 1  ──────────────▶  memory becomes trustworthy
   │                      (1.1 provenance gates the rest of the phase)
   │
Phase 2  ──────────────▶  interface surfaces it
   │                      (needs Phase 1: don't make bad memory more visible)
   │
Phase 3  ──────────────▶  legibility, throughout
```

**Parallelisable:** Phase 3's UI items (3.2, 3.4, 3.5) are front-end-only and independent
of Phases 0–1; they can run alongside from the start.

**Hard dependencies:** 1.1 before 1.2/1.3/1.5. 3.1 before 1.4. Phase 1 before Phase 2.
0.6's decision before any container deployment.

# Risks

- **The single conversation grows unreadable.** Mitigated by 2.2 and 2.4; the failure mode
  is real and `mirror.ts` names it.
- **Decay deletes something true.** Floor at 0.10 rather than zero, exempt
  anchor/user/project, and land 1.5 first so a wrong decay is correctable.
- **Verification costs latency.** "Verify, don't recall" means more tool calls per turn.
  Scope it to load-bearing claims, not every recalled fact — and 1.2's faithfulness score
  is what identifies which are which.
- **Permanent taint** (review N2) bites harder as verification drives more `web_fetch`.
  A conversation that verifies anything is behind the taint rules for good. An explicit
  primary-user clear action becomes necessary in Phase 2, not optional.

# Working rules

Unchanged from what the repo already does, and they are why this is tractable:
every phase ends green on `npm test` plus both typechecks; a fix that cannot be asserted
gets a contract before it gets a commit; comments explain the bug a decision prevents;
one commit per coherent change.
