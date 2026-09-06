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

// --- the plan survives a restart -------------------------------------------
// The document path lived in a process-local Map while the plan lived in the
// tasks table, so a restart stranded the plan with no file to write it to.
// "Anything that only exists in memory for the duration of a request is a
// regression" — CLAUDE.md — and this was one.
{
  const { getSession } = await import(dist("db.js"));
  await createSession({ id: "w4", title: "w4", workspace, executor: "host" });
  const c4 = mount("w4", workspace);
  await c4("write_plan", { file: "durable.md", sections: ["Alpha", "Beta"] });

  ok("the document path is on the session row",
     (await getSession("w4"))?.writing_file?.endsWith("durable.md") === true);

  // A fresh mount is what a restart looks like: new process, same session.
  const afterRestart = mount("w4", workspace);
  const out = await afterRestart("write_next", { content: long("Survived the restart.") });
  ok("a new process picks the document back up", /Wrote "Alpha"/.test(out));
}

// --- research before writing about the world -------------------------------
// Sisyphean's decomposer required research and write_doc to be separate steps
// for anything factual. write_plan plans the sections of the output and says
// nothing about the work needed to produce it, so a factual document was
// written straight from what the model already believed.
{
  await createSession({ id: "w5", title: "w5", workspace, executor: "host" });
  const c5 = mount("w5", workspace);
  const cold = await c5("write_plan", { file: "facts.md", sections: ["One", "Two"] });
  ok("a plan with no research behind it says so", /have not looked anything up/.test(cold));
  ok("and says what to do about it", /search your memory|read the source|fetch the page/.test(cold));
  // It notices rather than refuses: marching a capable model through a research
  // stage is the pipeline shape this port rejected, and plenty of documents are
  // legitimately written from what is known.
  ok("but the plan is still made", /Planned 2 section/.test(cold));
}

// --- the verifier, which shipped missing -----------------------------------
{
  await createSession({ id: "w6", title: "w6", workspace, executor: "host" });
  const c6 = mount("w6", workspace);
  await c6("write_plan", { file: "checked.md", sections: ["First", "Second"] });
  await c6("write_next", { content: long("The first section.") });

  const check = await c6("write_check", {});
  ok("it reports position", /1 of 2 section/.test(check));
  ok("names what is left", /Still to write: Second/.test(check));
  ok("and shows the end of the file", /first section/.test(check));
  ok("with nothing wrong", /Nothing looks wrong/.test(check));

  // The regression Sisyphean's verifier existed to catch: a whole-file write
  // that replaced the document instead of appending to it. Silent otherwise —
  // the file looks finished and half of it is gone.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(workspace, "checked.md"), "tiny\n");
  const damaged = await c6("write_check", {});
  ok("an overwrite is caught", /overwrote earlier work/.test(damaged));

  writeFileSync(path.join(workspace, "checked.md"), `${long("Restored.")}\n\nTODO: finish this\n`);
  ok("a stub left behind is caught", /"TODO" is still in the text/.test(await c6("write_check", {})));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
