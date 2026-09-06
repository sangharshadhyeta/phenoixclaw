/**
 * What is running, in front of the conversation, and where a follow-up goes.
 *
 * `tasks_running` existed as a tool and that is not enough — the pattern is
 * well established here by now: a tool the model has to think to call is one it
 * does not call at the moment it matters. Asked "how is that going?" it would
 * answer from what it remembered starting.
 *
 * BirdClaw injects the list instead (`soul_loop`'s active-task block), which is
 * also what makes a follow-up routable: "make it handle negatives too" is not
 * new work and is not the conversation's to do — it belongs to one of three
 * running tasks, and the conversation has to be able to say which.
 *
 *     npm run test:tasks-context
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { tasksBlock, elapsed, tasksContext } = await import(
  path.join(here, "..", "dist", "pi", "tasks-context.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const NOW = Date.parse("2026-09-06T12:00:00Z");
const task = (id, title, status, mins = 0, extra = {}) => ({
  id, title, status, kind: "task", started_by: "conv",
  updated_at: new Date(NOW - mins * 60_000).toISOString().replace("T", " ").slice(0, 23),
  last_error: null, ...extra,
});

// --- how long it has been going ---------------------------------------------
{
  ok("seconds", elapsed(new Date(NOW - 30_000).toISOString(), NOW) === "30s");
  ok("minutes", elapsed(new Date(NOW - 300_000).toISOString(), NOW) === "5m");
  ok("hours", elapsed(new Date(NOW - 7_200_000).toISOString(), NOW) === "2h");
  ok("nothing is nothing", elapsed(undefined, NOW) === "");
  ok("and nonsense does not throw", elapsed("not a date", NOW) === "");
  /**
   * DuckDB's timestamps carry no zone and `new Date` reads a bare one as
   * local. On a machine at +05:30 that made three minutes ago read as five
   * hours — wrong in the direction that matters, since the number exists to
   * say whether something is progressing or stuck.
   */
  ok("a bare database timestamp is read as UTC", elapsed("2026-09-06 11:57:00.000", NOW) === "3m");
  ok("and one that carries a zone is left alone", elapsed("2026-09-06T11:57:00.000Z", NOW) === "3m");
}

// --- the block ---------------------------------------------------------------
{
  ok("nothing running says nothing", tasksBlock([], NOW) === "");

  const one = tasksBlock([task("abc123", "write the parser", "running", 3)], NOW);
  ok("running work is listed", /write the parser/.test(one));
  ok("with its id, so a follow-up can name it", /\[abc123\]/.test(one));
  ok("and how long it has been going", /running 3m/.test(one));
  // The point of the block, not a nicety.
  ok("it says what to do with a follow-up", /tell_task/.test(one));
  ok("and warns against starting a second task instead", /rather than starting a new one/.test(one));

  // "Did that work?" arrives just after something finished; a list that drops
  // a task the moment it settles cannot answer it.
  const done = tasksBlock([task("d1", "the guide", "idle", 1)], NOW);
  ok("recently finished work is kept", /the guide/.test(done) && /Finished/.test(done));
  const failed = tasksBlock([task("e1", "the build", "error", 1, { last_error: "tsc exploded" })], NOW);
  ok("and a failure says so", /tsc exploded/.test(failed));

  // A session a person created has nobody waiting on it and is not the
  // conversation's to track.
  ok("work nobody handed out is not listed",
     tasksBlock([{ ...task("x", "mine", "running"), started_by: null }], NOW) === "");
  ok("nor are agent or routine sessions",
     tasksBlock([{ ...task("y", "loop", "running"), kind: "routine" }], NOW) === "");
}

// --- the injection ------------------------------------------------------------
{
  const mount = (load) => {
    let handler;
    tasksContext(load)({ on: (e, fn) => { if (e === "before_provider_request") handler = fn; }, registerTool() {} });
    return (payload) => handler({ type: "before_provider_request", payload });
  };
  const sys = { role: "system", content: "YOU ARE THE AGENT" };
  const convo = [sys, { role: "user", content: "how is that going?" }];

  const out = await mount(async () => [task("abc123", "the parser", "running", 2)])({ model: "m", messages: convo });
  ok("it is appended to the system prompt", /YOU ARE THE AGENT/.test(out.messages[0].content) && /the parser/.test(out.messages[0].content));
  ok("adding no message of its own", out.messages.length === convo.length);
  ok("and keeping the payload", out.model === "m");

  ok("nothing running leaves the request alone", (await mount(async () => [])({ messages: convo })) === undefined);
  ok("an unrecognised payload passes through", (await mount(async () => [task("a", "x", "running")])({ prompt: "no" })) === undefined);
  // Not knowing what is running must not stop the conversation.
  ok("a failed lookup passes through",
     (await mount(async () => { throw new Error("db gone"); })({ messages: convo })) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
