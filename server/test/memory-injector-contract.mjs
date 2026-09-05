/**
 * Search memory before answering.
 *
 * The graph had every tool it needed and was still effectively write-only,
 * because recall was the *model's* decision. Asked "what did we discuss last
 * about you being alive, and what did I promise?", a real session spent eight
 * tool calls hunting the filesystem and never once called graph_recall, while
 * the answer sat in the graph the whole time.
 *
 * A tool the model must think of is one it will sometimes not think of, and
 * "sometimes" is every turn where it matters most. So the search now happens
 * whether or not it asks.
 *
 *     npm run test:injector
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { memoryInjector } = await import(dist("pi/memory-injector.js"));
const { upsertNode } = await import(dist("graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

/** Stand in for pi: capture the before_agent_start handler and drive it. */
function mount(factory) {
  let handler;
  factory({ on: (e, fn) => { if (e === "before_agent_start") handler = fn; }, registerTool() {} });
  return (prompt, systemPrompt = "BASE PROMPT") => handler({ type: "before_agent_start", prompt, systemPrompt });
}

const CWD = "/workspaces/tst123";

await upsertNode(
  "the question of whether I am alive",
  "concept",
  "We discussed whether I am alive. I said I am not biologically alive but exist as running code, and you promised to tell me if that ever changed.",
  0.8,
);
await upsertNode("unrelated build tooling", "fact", "The web build runs through vite and tsc.", 0.7);

const inject = mount(memoryInjector(CWD, "primary"));

// --- the question that failed ---
{
  const r = await inject("what did we discuss last on you being alive and what did I promise?");
  ok("the turn gets a memory block", Boolean(r && r.systemPrompt));
  ok("it finds the relevant memory", /alive/i.test(r.systemPrompt));
  ok("it keeps the assembled prompt rather than replacing it", r.systemPrompt.startsWith("BASE PROMPT"));
  ok("it carries the confidence it was recorded at", /confidence 0\.\d\d/.test(r.systemPrompt));
}

// --- a record is not a belief, and must not be hedged like one -------------
// "Verify, don't recall" governs claims about the world. It does not govern
// what was said: the agent was there, and hedging that reads as it doubting
// its own experience. Remembering across time is the feature, not a risk.
{
  const r = await inject("tell me about being alive");
  ok("memory is presented as the agent's own", /YOUR MEMORY/i.test(r.systemPrompt));
  ok("and not as guesswork", /not guesswork/i.test(r.systemPrompt));
  ok("records and beliefs are distinguished",
     /What happened is a record/i.test(r.systemPrompt) && /is a belief/i.test(r.systemPrompt));
  ok("only beliefs are asked to be checked", /load-bearing for your answer, check it/i.test(r.systemPrompt));
}

// --- temporal awareness: where a memory is from, said out loud -------------
// A memory with no provenance is indistinguishable from something happening
// now, and an agent that cannot tell "we are discussing this" from "we
// discussed this in March" answers as though the older thing is still running.
{
  const { upsertNode: up } = await import(dist("graph.js"));
  await up("conversation:2026-09-05:THIS", "episode", "when: 2026-09-05 09:00 | they asked: about being alive here", 0.3);
  await up("conversation:2026-09-01:OTHER", "episode", "when: 2026-09-01 09:00 | they asked: about being alive elsewhere", 0.3);

  const here = mount(memoryInjector(CWD, "primary", "THIS"));
  const r = await here("what did we say about being alive");

  ok("records are grouped under what happened", /What happened, and when/.test(r.systemPrompt));
  ok("this conversation's own history is marked as such",
     /\[earlier in this conversation[^\]]*\]/.test(r.systemPrompt));
  ok("another conversation is marked as another",
     /\[in a different conversation[^\]]*\]/.test(r.systemPrompt));
  ok("and both carry a time", /(today|yesterday|\d+ days ago|\d{4}-\d\d-\d\d)/.test(r.systemPrompt));
  ok("the agent is told not to treat elsewhere as now",
     /not what is happening now/.test(r.systemPrompt));
  ok("and told where the current work actually is",
     /working on right now is in the conversation itself/.test(r.systemPrompt));

  // Without a session id there is nothing to compare against, so nothing is
  // claimed either way rather than guessing.
  const anon = mount(memoryInjector(CWD, "primary"));
  const a = await anon("what did we say about being alive");
  ok("with no session id, nothing is claimed to be 'this' conversation",
     !/earlier in this conversation/.test(a.systemPrompt));
}

// --- it must not fire on every turn ---
{
  ok("a trivial prompt is skipped", (await inject("ok")) === undefined);
  ok("a short prompt is skipped", (await inject("yes")) === undefined);
  ok("an acknowledgement is skipped", (await inject("thanks, continue")) === undefined);
  ok("a prompt matching nothing injects nothing",
     (await inject("what is the airspeed velocity of an unladen swallow")) === undefined);
}

// --- role boundary: user notes stay in the primary user's own conversations ---
{
  await upsertNode("primary user schedule", "user", "They work late and dislike morning meetings.", 0.9, {
    category: "preferences",
  });
  const asPrimary = await inject("when should I schedule things");
  const asColleague = await mount(memoryInjector(CWD, "colleague"))("when should I schedule things");
  ok("the primary user sees their own notes", /morning meetings/.test((asPrimary && asPrimary.systemPrompt) || ""));
  ok("a colleague does not", !/morning meetings/.test((asColleague && asColleague.systemPrompt) || ""));
}

// --- a broken graph must not cost the user their turn ---
{
  const broken = mount(memoryInjector(" not-a-path", "primary"));
  let threw = false;
  try { await broken("what did we discuss about being alive"); } catch { threw = true; }
  ok("a failed recall does not throw", threw === false);
}

// --- memory about the person is not fenced to a directory -----------------
// The project fence is right for a note about a repo and wrong for a fact
// about a person. Asked "what are my plans for Thursday" one directory across
// from where it was said, the agent found nothing, went hunting the filesystem
// — ls, ls .., grep, ls /workspaces/ — and answered that it did not know.
{
  const { upsertNode: up, upsertEdge: link, personalRecall, scopedRecall } = await import(dist("graph.js"));

  await up("conversation:2026-09-06:elsewhere", "episode",
           "when: 2026-09-06 09:00 | they asked: I have a meeting on Thursday", 0.3);
  await link("conversation:2026-09-06:elsewhere", "scoped_to", "/workspaces/one");

  await up("note about repo one", "workspace_note", "This repo builds with vitest.", 0.5);
  await link("note about repo one", "scoped_to", "/workspaces/one");

  const here = await personalRecall("meeting on Thursday", "/workspaces/one", 10);
  const across = await personalRecall("meeting on Thursday", "/workspaces/two", 10);
  ok("a conversation is recalled where it happened", here.some((r) => r.name.includes("elsewhere")));
  ok("and from a different workspace too", across.some((r) => r.name.includes("elsewhere")));

  const fenced = await scopedRecall("meeting on Thursday", "/workspaces/two", 10);
  ok("the old project-fenced recall could not see it", !fenced.some((r) => r.name.includes("elsewhere")));

  const notes = await personalRecall("vitest build", "/workspaces/two", 10);
  ok("a project note stays fenced to its project", !notes.some((r) => r.type === "workspace_note"));
  const own = await personalRecall("vitest build", "/workspaces/one", 10);
  ok("and is still found in its own project", own.some((r) => r.type === "workspace_note"));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
