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
| SIS-55 | Plan the **files of a project** in dependency order, not just the sections of one file. | `write_project`. A file is written whole rather than appended, `writing_mode` on the session says which unit the plan is in, and the project gets a directory in the store named after its entry point. The part specific to files rather than sections: each file's brief carries what the *earlier files* declare (`signaturesOf` across the directory), because a module written before the thing it imports has nothing to match — the same failure `signaturesOf` prevents within a file, one level up. Sisyphean asked a 0.6B model for the order with a JSON schema; here it is a parameter. | done |
| SIS-50 | A step must be followable with no history: "run `x` and check for ≥5 rows", never "continue the previous work". | `pi/step-text.ts`, used by both planners. It warns rather than refuses, because a word list cannot tell "continue the refactor" from "add a Continue button" — and names the step, says what is missing, and gives the reason. Load-bearing now rather than good practice: each step runs in its own context, so the step's own text is most of what the next turn has. | done |
| BC-15 | Record `expected_outcome` — how we will know it worked — **before** the work starts. | An `expected_outcome` tool and a column on `sessions`, carried into the closing turn: "you wrote that before starting — is it true, and did you check?" The value was never in the storing; it is in being asked by something that cannot invent the standard afterwards. Deliberately unenforced — nothing here can tell whether "the tests pass" is true. | done |
| BC-05, SIS-61 | Give a step only the tools it needs. | `pi/driving.ts`, checked in the guard. The audit was right that per-stage tool *menus* are small-model scaffolding — a capable model chooses fine, and a per-query list is not cache-friendly. What it missed is that scoping is not only about focus: a step being driven is inside a plan the portal is executing, and `write_plan`, `write_project`, `task_plan` and `task_start` act on that plan mid-flight. Every one of the four is a failure watched in a live run. A short denylist rather than an allowlist, because the turn was asked for and the risk is bounded to the plan; the `extend` turn lifts it, being the one turn meant to re-plan. | done |
| SIS-73 | Other harnesses reaching this agent's memory and guard through a standard endpoint. | `api/messages.ts` — `POST /api/v1/messages`, authenticated with `x-api-key` and deliberately *not* the portal cookie, so a logged-in browser does not become a way for any page it visits to drive the agent. pi's `server` package speaks pi's own protocol, so this was built. The caller's transcript is ignored and the response says so: a Messages request carries the whole conversation because the server is assumed to have no memory, and this one has its own. `metadata.user_id` picks the session, so the same client keeps the same memory. Streaming is refused rather than faked. | done |
| BC-02 | Decide the path before acting: `answer` / `run_command` / `create_task` / `escalate`. | Three of the four already exist in better form — `answer` is an ordinary turn, `create_task` is `task_plan`/`write_plan` with the portal driving the steps. `run_command` needed building after all — the standing practice ("Arithmetic … put them through `bash`") was assumed to cover it, and a live request through the Messages endpoint answered "What is 17 times 23?" with **393**, in one word, no tool call. `arithmeticNote` in `pi/preflight.ts` catches a sum in the request the same way the referent check does. `escalate` had no equivalent, and its condition is the checkable one: a bare pronoun with no antecedent. `pi/preflight.ts` catches it, because the model cannot — its context is full of memory and identity and "it" will find something to attach to in all of that, while whether *this* conversation has an antecedent is a property of the event log. Warns rather than blocks: a terse request is not a wrong one. | done |

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
