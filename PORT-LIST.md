# Port list: everything from BirdClaw and Sisyphean

## Why this file replaces the audit's verdicts

The feature audit sorted BirdClaw's and Sisyphean's modules into `PORTED`, `SUPERSEDED` and
`DELIBERATELY DROPPED`, and thirty rows landed in that last bucket on the grounds that they were
scaffolding for a 0.6B–4B model.

That reasoning has now failed three times in a row, each time in a way that was measurable:

- **SIS-53, incremental writing.** Dropped as small-model staging. Restored, and a live session
  asked for a four-function module now plans it and writes it a function at a time. The three
  arguments in `writing-tools.ts` — attention thins across one pass, a call that dies at eighty
  per cent leaves nothing, resuming needs somewhere to have left off — are not about capacity.
- **Per-step context isolation.** Dropped for the same reason. It is the difference between a
  step written with the plan and what came before it, and a step written behind twenty turns of
  tool output that nothing needed.
- **BC-60, the response adapter.** Filed under "hallucinated tool shapes are a small-model failure
  mode". Then a 26B model sent `task_plan` its steps as objects with double-quoted keys, got
  `must be string` six times, and recovered by accident on the seventh. The adapter was not a
  crutch; it was a tool being liberal in what it accepts.

The common error is the same each time: the audit judged the **mechanism** — a pipeline marching a
weak model through stages, a grammar-constrained router, a JSON repair loop — decided the mechanism
was only needed because the model was small, and threw away the **problem it was solving** with it.
The mechanisms mostly were small-model shaped. The problems were not.

So the standing policy is now: **nothing is rejected.** Every idea in either project gets ported,
in the shape the substrate makes right. Where pi already solves the problem, the port is "pi does
this, here is where" — which is a port, not a rejection, and it belongs in this file so nobody
re-derives the question later. The POCs' limitations were their code's; the substrate is where
those go away.

## How to read a row

**Idea** is what the module was for, stated without its machinery. **Port** is the shape it takes
here. **State** is one of `done` (built and under contract), `next`, or `open`.

---

## Built since the policy changed

| From | Idea | Port | State |
| --- | --- | --- | --- |
| BC-01 | A plan held only in the conversation is lost when the conversation is truncated, so re-state it every turn. | `pi/plan-context.ts` appends the live plan to the system prompt on every provider request — not per turn, because `task_start`/`task_finish` fire inside a turn. A finished plan is dropped. | done |
| BC-06, SIS-52 | After each step, judge: continue, deepen, or done. The worker cannot judge this from inside the work. | `pi/supervisor.ts` — a separate model call with the agent's own `SELF_CONCEPT.md`, seeing the request, the plan, and what was actually done. It may only nudge. Repetition is caught without a model at all. | done |
| BC-07, SIS-53 | Verify the artefact mechanically before calling it finished: a section that shrank, a stub left behind, code that does not parse. | `checkDocument()` in `pi/writing-tools.ts`, run by `write_check` *and* by the step runner before it is allowed to answer. Language-aware: `...` is an ellipsis in prose and a spread operator in JavaScript. | done |
| BC-49 | Resume at a structural boundary, not a byte offset; read one section rather than the whole file. | `boundaryTail()` cuts forward to the next heading or definition. `read_section` and `write_revise` navigate by spans recorded when each section was written. | done |
| BC-60 | Be liberal in what a tool accepts; the model's reading of the schema is often the sensible one. | `task_plan` takes steps as strings *or* objects, under any key and any amount of quoting. | done |
| SIS-41 | A stall guard on a repeated `(tool, input)`. | `repetition()` in `pi/supervisor.ts`, over any tool rather than web search only, and it nudges rather than terminating. | done |
| SIS-51 | Each task runs in its own context with only what it needs. | `pi/step-runner.ts`: `briefFor()` composes goal + plan + what earlier steps produced + the end of the artefact. `write_plan` ends the turn, and the portal drives each step in a recycled conversation. | done |
| SIS-42 | Final-answer assembly, saying honestly what failed. | `synthesisBrief()` — its own context holding what every step produced, with failed steps named and unfixed defects carried into the answer. | done |
| BC-68 | Route a real task through the live agent and assert on the outcome. | `npm run test:e2e` — creates a session, prompts, waits for terminal status, and checks what is on disk. It caught the collapsed step budget that 600 unit assertions could not. | done |
| BC-15 | A step budget learned from history. | Removed for interactive sessions: pi's learned `maxSteps` had collapsed to 3. Progress, not a counter, is the bound. | done |
| SIS-42 | Never claim to have written or run something unless a result says you did. | Mechanical, not a rule in a prompt: `task_finish` refuses to close a section of a document that has no recorded span, because `write_next` records where every section landed. Dropped by the audit on the grounds that under pi the answering model made the calls itself — then a 26B model closed a step with "I have completed the area function." over an empty file. | done |
| BC-49 | Progressive disclosure — index, then the *exact* section matching this item, then goal-relevant lines, then last-heading-to-EOF. Only the last of the four was ported. | Three rungs, in `pi/step-runner.ts`. The index is `writtenIndex()`. The middle rung is `signaturesOf()` — what the file already declares, signatures without bodies, because a function that calls three others needs what they take and return and not their implementations. `neededSections()` returns an earlier section in full when this step's description names it, sliced exactly by the span `write_next` recorded rather than by BirdClaw's regex. Then the tail. Not every earlier section at any rung: that is the accumulating context this exists to avoid, reached by another road. | done |
| BC-49 | "The file is the memory." | Its missing half: the graph remembers *which* file and what it was for (`pi/prior-work.ts`), so an artefact is findable by what was asked rather than where it happened to be written. Each run used to start from an empty file while the last run's output sat in another workspace, so a second attempt was different rather than better. Hung off the recall the memory injector already does. | done |

## Next

| From | Idea | Port | State |
| --- | --- | --- | --- |
| SIS-55 | Plan the **files of a project** in dependency order, not just the sections of one file. | Widen `write_plan` to accept `{file, purpose}` entries; `write_next` opens the next file instead of appending to the current one. The plan store, ordering and resume machinery already exist. | next |
| SIS-50 | A step must be followable with no history: "run `x` and check for ≥5 rows", never "continue the previous work". | A contract of `task_plan`/`write_plan` — say it in the description and warn on steps containing back-references. It matters more now, not less: with per-step isolation the step text really is all the next context gets. | next |
| BC-15 | Record `expected_outcome` — how we will know it worked — **before** the work starts. | A column on `sessions`, set at creation, handed back in the closing turn: "you said this would be done when X; is X true?" Makes an unattended routine's result auditable instead of narrative. | next |
| BC-05, SIS-61 | Give a step only the tools it needs. | Per-step tool subsets, now that steps are separate calls. Cheaper and less distracting than one full set per turn — and unlike Sisyphean's per-query scoring, a per-step-kind set stays cache-friendly. | next |
| SIS-73 | Other harnesses reaching this agent's memory and guard through a standard endpoint. | A `/v1/messages` route mapping onto a portal session. A scope decision, not a capability one — the audit misfiled it as the latter. Check first whether pi already has a server mode. | open |
| BC-02 | Decide the path before acting. | Not a routing JSON, but the pre-flight judgement the loop still lacks: is this answerable from memory as it stands, or does it need work? Today every request goes the same way. | open |

## Ported already, recorded so the question is not re-opened

`BC-08` overlapped GPU calls (pi issues its own); `BC-38` a second graph (there is one);
`BC-43` the write guard's syntax gate (the build is the gate, and `checkDocument` is the rest);
`BC-56` thread-locals (tool factories close over their session); `BC-58` dual-model routing (session
work on the chosen model, background extraction on the local one via `llm.ts`); `BC-66` a reconnect
grace timer (a run belongs to the server; the SSE cursor replays); `BC-73` the TUI (`web/src`);
`BC-77` the engine client (in-process, `pi/types.ts`'s `PiClient` is the seam); `SIS-23` the artifact
store (the graph's `summary` already expresses that split); `SIS-49` a loop shell (pi owns the loop);
`SIS-62` the response assembler (`synthesisBrief` is its successor); `SIS-43` the consolidator
(superseded inside Sisyphean itself).
