/**
 * The plan, put back in front of the model.
 *
 * The bug this exists for: a plan written at the start of a long piece of work
 * reached the model once, as a tool result, and then aged out of the window —
 * so the session that most needed the plan was the one that no longer had it.
 *
 * Like the assembler, this runs on every provider call, so what it must *not*
 * touch matters more than what it adds.
 *
 *     npm run test:plan
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { planContext, planBlock } = await import(path.join(here, "..", "dist", "pi", "plan-context.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const task = (seq, description, status = "pending", result = null) => ({ seq, description, status, result });

// --- the block itself ---------------------------------------------------
ok("no plan, no block", planBlock([]) === "");
ok("a finished plan is history, not context",
   planBlock([task(1, "a", "done", "did it"), task(2, "b", "done", "did it")]) === "");

const mid = planBlock([task(1, "research", "done", "found three sources"), task(2, "draft", "running"), task(3, "edit")]);
ok("shows every step, done ones included", /research/.test(mid) && /draft/.test(mid) && /edit/.test(mid));
ok("carries the result of a finished step", /found three sources/.test(mid));
ok("says which step is in progress", /on step 2/.test(mid));
ok("names the tool that closes it", /task_finish/.test(mid));
ok("marks status distinguishably", /✓ \[1\]/.test(mid) && /▸ \[2\]/.test(mid) && /· \[3\]/.test(mid));

const fresh = planBlock([task(1, "intro"), task(2, "body")]);
ok("with nothing running, points at the next step", /Step 1 is next/.test(fresh));
ok("invites revision rather than treating the plan as fixed", /task_plan/.test(fresh) && /not a failure/.test(fresh));

const doc = planBlock([task(1, "intro"), task(2, "body")], "/w/report.md");
ok("a writing plan names the file", /\/w\/report\.md/.test(doc));
ok("a writing plan points at write_next, not task_finish", /write_next/.test(doc) && /write_plan/.test(doc));

// --- the injection ------------------------------------------------------
function mount(sessionId, loaded) {
  let handler;
  planContext(sessionId, async () => loaded)({
    on: (e, fn) => { if (e === "before_provider_request") handler = fn; },
    registerTool() {},
  });
  return handler ? (payload) => handler({ type: "before_provider_request", payload }) : undefined;
}

const plan = { tasks: [task(1, "intro"), task(2, "body", "running")], file: null };
const run = mount("s1", plan);
const sys = { role: "system", content: "YOU ARE THE AGENT" };
const convo = [sys, { role: "user", content: "hello" }];

const out = await run({ model: "m", messages: convo });
ok("appends to the system prompt", /YOU ARE THE AGENT/.test(out.messages[0].content) && /THE PLAN YOU WROTE/.test(out.messages[0].content));
ok("adds no message of its own", out.messages.length === convo.length);
ok("leaves the conversation untouched", out.messages[1].content === "hello");
ok("keeps the rest of the payload", out.model === "m");

const noSystem = await run({ messages: [{ role: "user", content: "hi" }] });
ok("with no system message, prepends one", noSystem.messages[0].role === "system" && noSystem.messages.length === 2);

const later = await run({ messages: [sys, { role: "user", content: "hi" }, { role: "system", content: "MID" }] });
ok("only the leading system message is the prompt", later.messages[2].content === "MID");

const parts = await run({ messages: [{ role: "system", content: [{ type: "text", text: "PARTS" }] }, { role: "user", content: "x" }] });
ok("handles content given as parts", /PARTS/.test(parts.messages[0].content) && /THE PLAN/.test(parts.messages[0].content));

// --- what it must not touch --------------------------------------------
ok("no session, no handler at all", mount(undefined, plan) === undefined);
ok("no plan, payload untouched", (await mount("s2", { tasks: [] })({ messages: convo })) === undefined);
ok("unrecognised payload passes through", (await run({ prompt: "not chat" })) === undefined);
ok("empty messages pass through", (await run({ messages: [] })) === undefined);
ok("a non-message array passes through", (await run({ messages: ["plain string"] })) === undefined);

const broken = mount("s3", null);
let threw = false;
let survived;
try { survived = await broken({ messages: convo }); } catch { threw = true; }
ok("a loader that fails does not break the request", !threw && survived === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
