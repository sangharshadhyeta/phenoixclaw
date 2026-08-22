# Routines

A routine is a standing instruction and a schedule. When it fires the agent is
given the instruction, does the work, and goes quiet again — nobody is waiting
on the other end, so a run may take as long as it takes.

Routines live in the sidebar next to Sessions and Agent. They run in the agent's
home directory, not a workspace, and they share the agent's memory.

## Scheduling

Either a five-field cron expression (`0 9 * * 1-5`) or one of the `@shorthands`,
**or** a single moment for a one-off. Never both — a routine that repeats and a
routine that happens once are different things, and the form says so rather than
guessing.

A one-off catches up: if its moment passed while the portal was down, it still
runs when the portal comes back. A recurring one does not — it simply waits for
its next slot, because ten missed hourly runs firing at once helps nobody.

`@idle` is a third kind, not a cron shorthand — it fires when the system has
gone quiet rather than on a clock. It waits for ten minutes with nothing
happening (no session running, no human activity on a task or agent
conversation — a routine session doesn't count, or a frequent idle routine
would keep the system looking permanently busy), then runs, and won't run
again for at least three hours even if it stays quiet the whole time. Real
activity arriving interrupts an in-progress `@idle` run — the routine's own
schedule kicking off is not "real activity," but a message from you is. The
seeded [self-reflection](#dream-cycle) routine is the only one that ships on
this schedule; nothing stops you creating your own.

By default a routine keeps one session, so a run can see what the last one did —
"nothing new since yesterday" needs yesterday. **Fresh session each run** gives
each one a clean start instead, for work where history is only noise.

## Reporting back

A run's closing account is stored, and stored is where it stays unless the
routine has somewhere to report. Give it one and the agent gets a `report` tool.

The agent decides **whether** a run is worth reporting and writes the message
itself. It does not decide **where** — that is configuration, so a routine
cannot start messaging somewhere it was never pointed at.

Two places to set it:

- **Settings → General → Routine reports** is the portal-wide default. Every
  routine inherits it, including one the agent creates for itself from a chat.
- **A routine's own page** overrides that: a different conversation, or *Never
  report* for one that should stay quiet whatever the default is.

A destination is a conversation that already exists — you pick "telegram —
Anirban Kar", not a chat id. Only channels that can start a conversation appear;
a webhook cannot, because it only ever answers a request that is already open.

A routine created from a chat reports back **into that chat** — asking for a
morning summary in Telegram means "tell me here". The portal-wide default
applies to routines created any other way, and to conversations whose channel
cannot be messaged out of the blue.

What a routine says into a conversation becomes part of it. Ask "what did you
mean by that?" the next morning and the agent knows what "that" was, because the
report is folded into the conversation's next turn rather than only being
delivered.

::: tip Silence is a result
The agent is told to skip the report when a run was uneventful. A report that
says nothing happened trains you to ignore the next one — and the next one might
be the one that mattered.
:::

## The injection guard

By default a run that reads something untrusted — logs pulled over the network,
a web page, mail — cannot then push, write onto `PATH`, upload data or read
credentials. That is the [guard](/guide/security), and for most routines it
never comes up.

It gets in the way of one honest shape of work: **read the logs, then fix what
they say**. Fetching the logs taints the session, and the fix is a push. Grepping
those logs for the word `token` looks like reading credentials. Nothing is
wrong, and the run stops anyway.

**Injection guard** on a routine's page turns the blocking off for that routine
alone. Two things stay:

- Untrusted content is still labelled as untrusted, so the agent knows what it
  is reading. That half never gets in the way.
- Anything it does that the rules would have stopped is recorded in **Audit** as
  `allowed-by-exemption`, with the rule that would have fired.

::: warning Turn it off for the routine, not the habit
The rules exist for when the log line was written by somebody who wanted the
agent to read it. Exempt the routine that needs it, leave the rest alone, and
read the audit occasionally.
:::

## Dream Cycle

A routine called **self-reflection** is seeded once, on `@idle`, the first time
the portal starts. It's guarded by slug so a restart never recreates it — if
you disable or rewrite it, that choice sticks.

Its instructions walk the agent through seven phases in order:

1. **Memorise** — call `memory_digest` for excerpts of what's happened since
   the last run: recent session text, split into identity-relevant and general.
2. **Graph enrichment** — fold anything worth keeping into the [knowledge
   graph](/reference/architecture#knowledge-graph) with `graph_remember`.
3. **Inner life** — update `INNER_LIFE.md`, a first-person present-tense
   account of recent experience. Only what's genuinely new.
4. **Self-concept** — update `SELF_CONCEPT.md` with reasoned conclusions about
   identity and capability, folding in anything the digest flagged as
   identity-relevant.
5. **Skill synthesis** — if the digest reveals a reusable pattern, write it as
   a new skill.
6. **Cleanup** — prune stale sessions and old routines with the `cleanup`
   tool.
7. **Report** — a short account to the routine's report target, same as any
   other routine (see [Reporting back](#reporting-back)).

### Resuming a cycle

Seven phases is a while to sit unwatched. If the run is interrupted — real
activity arrives and the `@idle` run gets aborted, or the portal restarts —
resuming from phase one would repeat work already done and risk creating
duplicate memories.

The agent has a `dream_progress` tool for this: called with the exact header
of the next phase (`"PHASE 2: GRAPH ENRICHMENT"`), it rewrites the routine's
own `instructions` to start from that point. The next run — whether it's a
retry of the interrupted one or the routine's next scheduled fire — picks up
where the last one left off instead of starting over. The seed instructions
tell the agent to call this after finishing each phase, so a healthy cycle
walks its own instructions forward one phase at a time as it goes.

## Letting the agent manage them

Sessions reached through a channel get `routines_list`, `routine_create`,
`routine_update` and `routine_run`, so "remind me every morning to check the
backups" writes the routine instead of telling you where the button is.

Task sessions do not get them — a session working inside your repository has no
business rescheduling anything. Neither does a routine run: a routine that can
create routines can build a chain with nobody watching it.

There is no delete tool. Disabling stops a routine firing and leaves it visible,
so a misheard "cancel the morning thing" is recoverable. Deleting stays a
deliberate act in the UI.
