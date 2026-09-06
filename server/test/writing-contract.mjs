/**
 * Writing something long, one section at a time.
 *
 * Sisyphean's write-plan pipeline (SIS-53), which the feature audit marked
 * DELIBERATELY DROPPED as small-model scaffolding. That judgement looked at the
 * mechanism — a pipeline marching a 0.6B model through stages — and threw away
 * the idea with it. The idea is sound for any model size:
 *
 *   - attention thins across a long single call, so the last section is written
 *     with the least budget remaining;
 *   - a call that dies at 80% leaves nothing, where a file on disk is state;
 *   - "carry on where you left off" needs somewhere to have left off.
 *
 * What changed in the port is who drives: tools the model chooses, not stages
 * it is pushed through.
 *
 *     npm run test:writing
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { writingTools } = await import(dist("pi/writing-tools.js"));
const { createSession, listTasks } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const workspace = mkdtempSync(path.join(tmpdir(), "writing-"));
await createSession({ id: "w1", title: "w", workspace, executor: "host" });

/** Collect the registered tools and call them the way pi would. */
function mount(sessionId, cwd) {
  const tools = {};
  writingTools(sessionId, cwd)({ on() {}, registerTool: (t) => (tools[t.name] = t) });
  return async (name, args) => {
    const r = await tools[name].execute("id", args);
    return r.content[0].text;
  };
}
const call = mount("w1", workspace);
const long = (s) => `${s} `.repeat(60);

// --- planning ---------------------------------------------------------------
{
  const out = await call("write_plan", { file: "guide.md", sections: ["Intro", "Middle", "End"] });
  ok("a plan is made", /Planned 3 section/.test(out));
  ok("and the sections are listed back", /Intro/.test(out) && /End/.test(out));

  // Resolved against the session's workspace, not the server's cwd. The first
  // live test wrote into the Phoenixclaw checkout, reported success, and left
  // the agent unable to find what it had written.
  ok("the file is created in the workspace", existsSync(path.join(workspace, "guide.md")));
  ok("and not in the server's cwd", !existsSync(path.join(process.cwd(), "guide.md")));

  // One notion of "the steps I am working through", not two.
  const tasks = await listTasks("w1");
  ok("the plan is the session's task list", tasks.length === 3);
  ok("in order", tasks[0].description === "Intro" && tasks[2].description === "End");
}

// --- writing, one section per call -----------------------------------------
{
  const first = await call("write_next", { content: long("An opening paragraph.") });
  ok("a section is written", /Wrote "Intro"/.test(first));
  ok("and the next one is named", /Next: "Middle"/.test(first));
  ok("with what is already there, so it follows on", /opening paragraph/.test(first));

  const file = () => readFileSync(path.join(workspace, "guide.md"), "utf8");
  ok("the file has the content", /opening paragraph/.test(file()));

  await call("write_next", { content: long("The middle of the argument.") });
  ok("sections accumulate", /opening paragraph/.test(file()) && /middle of the argument/.test(file()));
  ok("separated by a blank line", /\n\n/.test(file()));

  const done = await call("write_next", { content: long("A closing thought.") });
  ok("the last section finishes the document", /complete/.test(done));
  // Finishing clears the document, so a further call says there is nothing in
  // progress rather than nothing left — both true, and it must not append past
  // the end of the plan either way.
  const after = await call("write_next", { content: long("extra") });
  ok("writing past the end is refused", /No document in progress|Every planned section/.test(after));
  ok("and nothing was appended", !/extra/.test(file()));
}

// --- the refusal that makes it worth having --------------------------------
// A section written in one line is the failure this exists to prevent, and
// silently accepting it produces a document that looks planned and reads like
// an outline.
{
  await createSession({ id: "w2", title: "w2", workspace, executor: "host" });
  const c2 = mount("w2", workspace);
  await c2("write_plan", { file: "thin.md", sections: ["One", "Two"] });

  const refused = await c2("write_next", { content: "Too short." });
  ok("a one-line section is refused", /too short/i.test(refused));
  ok("saying how much is wanted", /\d+ characters/.test(refused));
  ok("and offering the honest alternative", /write_skip/.test(refused));
  ok("the plan does not advance", (await listTasks("w2")).filter((t) => t.status === "done").length === 0);

  const skipped = await c2("write_skip", { why: "Covered by the other section." });
  ok("a section can be dropped with a reason", /Skipped "One"/.test(skipped));
  ok("and the reason is kept",
     (await listTasks("w2")).some((t) => t.result.includes("Covered by")));
}

// --- writing without planning ----------------------------------------------
{
  await createSession({ id: "w3", title: "w3", workspace, executor: "host" });
  const c3 = mount("w3", workspace);
  ok("write_next without a plan says so", /No document in progress/.test(
    await c3("write_next", { content: long("orphan") }),
  ));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
