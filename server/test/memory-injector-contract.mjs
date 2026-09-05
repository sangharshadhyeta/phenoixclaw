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

// --- a lead, not an answer: the epistemics must be stated ---
{
  const r = await inject("tell me about being alive");
  ok("the block says it is unverified", /have not verified/i.test(r.systemPrompt));
  ok("and says to check what is load-bearing", /check it before relying/i.test(r.systemPrompt));
  ok("and to say when answering from memory", /from memory rather than/i.test(r.systemPrompt));
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

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
