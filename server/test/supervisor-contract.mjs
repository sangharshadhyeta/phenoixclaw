/**
 * The outer loop: something that watches the work and is not doing it.
 *
 * The worker is a poor judge of its own progress for a structural reason — every
 * observation it made is in its own context, so the fourth identical read looks
 * reasonable from inside, and "I have enough" is judged by the same attention
 * that just spent itself gathering. So the judgement is a separate call, with
 * the agent's own self-concept in it, and it may only nudge.
 *
 * What this must get right is mostly the failure paths: a supervisor that
 * cannot reach its model, or answers with something unparseable, must not stop
 * the work it was supervising.
 *
 *     npm run test:supervisor
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { repetition, parseSupervision, superviseBlock, supervise, dueForReview } = await import(dist("pi/supervisor.js"));
const { loopSupervisor } = await import(dist("pi/loop-supervisor.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };
const call = (toolName, args = {}) => ({ toolName, args: JSON.stringify(args) });

// --- repetition, found without a model --------------------------------------
{
  const same = [call("read", { path: "README.md" })];
  ok("two of the same is not yet a pattern", repetition([...same, ...same]) === undefined);
  ok("three identical calls is", /same arguments 3 times/.test(repetition([...same, ...same, ...same]) ?? ""));
  ok("and it names the tool", /`read`/.test(repetition([...same, ...same, ...same]) ?? ""));
  ok("and says not to call it again", /do not call it again/.test(repetition([...same, ...same, ...same]) ?? ""));

  const varied = [call("read", { path: "a" }), call("read", { path: "b" }), call("read", { path: "c" })];
  ok("the same tool on different arguments is work, not repetition", repetition(varied) === undefined);

  // Only the recent window counts: three reads of the same file an hour and
  // twenty calls ago is not a loop.
  const old = [...same, ...same, ...same, ...Array.from({ length: 8 }, (_, i) => call("write", { i }))];
  ok("old repetition ages out of the window", repetition(old) === undefined);
}

// --- reading the verdict back -----------------------------------------------
{
  ok("a clean answer parses",
     parseSupervision("VERDICT: deepen\nNOTE: You have not checked the version.")?.verdict === "deepen");
  ok("and carries the note",
     /checked the version/.test(parseSupervision("VERDICT: deepen\nNOTE: You have not checked the version.")?.note ?? ""));
  ok("a fenced or prefaced answer still parses",
     parseSupervision("Here is my judgement.\n```\nVERDICT: stuck\nNOTE: Try something else.\n```")?.verdict === "stuck");
  ok("'none' is an empty note, not the word none",
     parseSupervision("VERDICT: continue\nNOTE: none")?.note === "");
  ok("an invented verdict is refused", parseSupervision("VERDICT: vibes\nNOTE: hmm") === undefined);
  ok("prose with no verdict is refused", parseSupervision("I think it's going fine, honestly.") === undefined);
  ok("nothing at all is refused", parseSupervision(undefined) === undefined);
}

// --- how it is put to the worker --------------------------------------------
{
  ok("continue says nothing", superviseBlock({ verdict: "continue", note: "looks fine" }) === "");
  ok("a verdict with no note says nothing", superviseBlock({ verdict: "deepen", note: "" }) === "");
  ok("no verdict at all says nothing", superviseBlock(undefined) === "");

  const block = superviseBlock({ verdict: "off-track", note: "You were asked for a summary, not a rewrite." });
  ok("a real verdict is shown", /STEPPING BACK/.test(block) && /not a rewrite/.test(block));
  ok("and framed as the agent's own second look", /looking at your own work from outside/.test(block));
  ok("and it may be argued with, not just obeyed", /say why it is wrong/.test(block));
}

// --- the failure paths, which matter most -----------------------------------
{
  // Repetition is caught without ever reaching the model.
  const same = [call("read", { path: "x" })];
  const noModel = await supervise("s", "do a thing", {
    calls: async () => [...same, ...same, ...same],
    ask: async () => { throw new Error("the model should not have been asked"); },
  });
  ok("repetition needs no model call", noModel?.verdict === "stuck");

  const dead = await supervise("s", "do a thing", {
    calls: async () => [call("read", { path: "a" })],
    tasks: async () => [],
    self: async () => "",
    ask: async () => undefined,
  });
  ok("a model that will not answer produces no verdict", dead === undefined);

  const garbage = await supervise("s", "do a thing", {
    calls: async () => [call("read", { path: "a" })],
    tasks: async () => [],
    self: async () => "",
    ask: async () => "I have no idea what you want from me.",
  });
  ok("an unparseable answer produces no verdict", garbage === undefined);

  // Identity is in the prompt: this is the loop that decides what "finished"
  // means, and finished is a standard, not a property of the material.
  let sawSelf = false, sawRequest = false;
  await supervise("s", "write the deployment guide", {
    calls: async () => [call("read", { path: "a" })],
    tasks: async () => [{ seq: 1, description: "intro", status: "done", result: "10 chars" }],
    self: async () => "I hold myself to checking things.",
    ask: async (_sys, user) => {
      sawSelf = /I hold myself to checking things/.test(user);
      sawRequest = /write the deployment guide/.test(user);
      return "VERDICT: continue\nNOTE: none";
    },
  });
  ok("the supervisor is given the agent's own self-concept", sawSelf);
  ok("and what was actually asked for", sawRequest);
}

// --- when it runs -----------------------------------------------------------
{
  ok("a review is not due immediately", !dueForReview(1, 0));
  ok("it becomes due after enough calls", dueForReview(4, 0));
  ok("and not again straight away", !dueForReview(5, 4));
}

// --- it must never stand in the worker's way --------------------------------
{
  // A distinct session per mount. They share a module-level map, and the
  // hanging-review case below would otherwise poison the ones after it — which
  // is exactly the bug it found: an in-flight flag that never cleared.
  let n = 0;
  function mount(deps) {
    let handler;
    loopSupervisor(`s${++n}`, deps)({ on: (e, fn) => { if (e === "before_provider_request") handler = fn; }, registerTool() {} });
    return (payload) => handler({ type: "before_provider_request", payload });
  }
  const sys = { role: "system", content: "YOU ARE THE AGENT" };
  const convo = [sys, { role: "user", content: "write the guide" }];

  const slow = mount({
    calls: async () => Array.from({ length: 8 }, (_, i) => call("read", { i })),
    review: () => new Promise(() => {}), // never resolves
  });
  const started = Date.now();
  const out = await slow({ messages: convo });
  ok("a review that never returns does not block the request", Date.now() - started < 1000);
  ok("and the request is passed through untouched", out === undefined);

  const failing = mount({
    calls: async () => { throw new Error("database is gone"); },
    review: async () => ({ verdict: "stuck", note: "x" }),
  });
  ok("an unreadable event log passes the request through", (await failing({ messages: convo })) === undefined);

  // The verdict lands on a later request, and is shown once.
  let asked = 0;
  const working = mount({
    calls: async () => Array.from({ length: 8 }, (_, i) => call("read", { i })),
    review: async () => { asked++; return { verdict: "synthesize", note: "You have enough. Write it." }; },
  });
  ok("the first request is not delayed by the first review", (await working({ messages: convo })) === undefined);
  await new Promise((r) => setTimeout(r, 20));
  const second = await working({ messages: convo });
  ok("the verdict arrives on a later request", /You have enough/.test(second?.messages?.[0]?.content ?? ""));
  ok("appended to the system prompt, not added as a message",
     /YOU ARE THE AGENT/.test(second.messages[0].content) && second.messages.length === convo.length);
  await new Promise((r) => setTimeout(r, 20));
  ok("and is not repeated on every request afterwards", (await working({ messages: convo })) === undefined);
}

// A hanging review must not turn the supervisor off for the rest of the
// session. `reviewing` is what stops two overlapping, so if it never clears
// the session quietly stops being watched — no crash, no log line.
{
  let calls = 8;
  let handler;
  let resolveSecond;
  let attempt = 0;
  loopSupervisor("s-hang", {
    calls: async () => Array.from({ length: calls }, (_, i) => call("read", { i })),
    review: () => (++attempt === 1 ? new Promise(() => {}) : Promise.resolve({ verdict: "stuck", note: "Try something else." })),
  })({ on: (e, fn) => { if (e === "before_provider_request") handler = fn; }, registerTool() {} });
  const run = (p) => handler({ type: "before_provider_request", payload: p });
  const convo = [{ role: "system", content: "S" }, { role: "user", content: "go" }];

  await run({ messages: convo });                       // starts the review that hangs
  await new Promise((r) => setTimeout(r, 400));          // past SUPERVISOR_TIMEOUT_MS in this run
  calls = 20;                                            // enough has happened for another
  await run({ messages: convo });                        // must be allowed to start one
  await new Promise((r) => setTimeout(r, 50));
  const out = await run({ messages: convo });
  ok("a hung review does not disable the supervisor for good",
     /Try something else/.test(out?.messages?.[0]?.content ?? ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
