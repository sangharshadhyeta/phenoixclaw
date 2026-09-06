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
const { createSession, getSession, listTasks } = await import(dist("db.js"));

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

  // Whatever the result ends on is what the model does next. The first live
  // run planned five sections, read the nudge as its closing line, and ended
  // the turn without writing anything.
  // The plan hands off. With the step cap removed a capable model will
  // otherwise work the whole plan inside one accumulating conversation, which
  // is the thing per-step isolation exists to avoid — the plan gets written and
  // then never used as a plan.
  ok("planning ends the turn rather than starting the work", /Stop here/.test(cold));
  ok("and says why the next context will be smaller", /on its own, in a context holding the plan/.test(cold));
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

// --- reading a section back, and revising it -------------------------------
// The gap that made these tools append-only. Writing a module a function at a
// time means finding out at function seven that function three was wrong, and
// until spans were recorded the only way back in was a whole-file `write` —
// the thing this exists to avoid, which write_check then reports as data loss.
{
  await createSession({ id: "w7", title: "w7", workspace, executor: "host" });
  const c7 = mount("w7", workspace);
  await c7("write_plan", { file: "revise.md", sections: ["Alpha", "Beta", "Gamma"] });
  await c7("write_next", { content: long("Alpha says one thing.") });
  await c7("write_next", { content: long("Beta says another.") });
  await c7("write_next", { content: long("Gamma concludes.") });

  const read = await c7("read_section", { section: 2 });
  ok("a written section can be read back exactly", /Beta says another/.test(read) && !/Alpha says/.test(read));
  ok("and it says which section it is", /Section 2/.test(read) && /Beta/.test(read));

  await createSession({ id: "w8", title: "w8", workspace, executor: "host" });
  const c8 = mount("w8", workspace);
  await c8("write_plan", { file: "unwritten.md", sections: ["One", "Two"] });
  ok("an unwritten section says so", /not written yet/.test(await c8("read_section", { section: 2 })));
  ok("a section that is not in the plan says so", /no section 9/.test(await c8("read_section", { section: 9 })));

  // The revision itself, and the thing that would be worse than not having it:
  // later sections must move, or read_section starts returning drifted text.
  const before = readFileSync(path.join(workspace, "revise.md"), "utf8");
  await c7("write_revise", { section: 1, content: long("Alpha, corrected and much longer now.") });
  const after = readFileSync(path.join(workspace, "revise.md"), "utf8");
  ok("the revision replaces the section", /Alpha, corrected/.test(after) && !/Alpha says one thing/.test(after));
  ok("and leaves the rest of the file standing", /Beta says another/.test(after) && /Gamma concludes/.test(after));
  ok("the file actually changed length", after.length !== before.length);

  const shifted = await c7("read_section", { section: 3 });
  ok("later sections still read back correctly after a shift",
     /Gamma concludes/.test(shifted) && !/Beta says another/.test(shifted));
  const stillBeta = await c7("read_section", { section: 2 });
  ok("and so do the ones in between", /Beta says another/.test(stillBeta) && !/Alpha, corrected/.test(stillBeta));

  ok("a revision that is really a deletion is refused",
     /too short/.test(await c7("write_revise", { section: 1, content: "no" })));
  ok("revising an unwritten section is refused",
     /not written yet/.test(await c8("write_revise", { section: 1, content: long("x") })));
}

// --- code is not prose ------------------------------------------------------
// A module assembled a function at a time can be the right length, have every
// planned section, and not compile. write_check said "nothing looks wrong".
{
  const { writeFileSync } = await import("node:fs");
  await createSession({ id: "w9", title: "w9", workspace, executor: "host" });
  const c9 = mount("w9", workspace);
  await c9("write_plan", { file: "mod.mjs", sections: ["helpers", "main"] });
  await c9("write_next", { content: `// helpers\nexport function add(a, b) {\n  return a + b;\n}\n${"// padding comment line\n".repeat(12)}` });
  ok("valid code passes the check", /Nothing looks wrong/.test(await c9("write_check", {})));

  // The research nudge asks whether a document's claims about the world were
  // checked. A mean() function makes none, so firing there is a warning that
  // is wrong every time.
  await createSession({ id: "w10", title: "w10", workspace, executor: "host" });
  const c10 = mount("w10", workspace);
  ok("code is not nagged about research",
     !/have not looked anything up/.test(await c10("write_plan", { file: "fresh.mjs", sections: ["a", "b"] })));

  // `...` is an ellipsis in prose and a spread operator in JavaScript. The stub
  // scan reported every foo(...args) as an unfinished document.
  writeFileSync(path.join(workspace, "mod.mjs"), `export const f = (...args) => args.length;\n${"// pad\n".repeat(40)}`);
  const spread = await c9("write_check", {});
  ok("a spread operator is not reported as a stub", !/"\.\.\." is still in the text/.test(spread));

  writeFileSync(path.join(workspace, "mod.mjs"), `export function broken( {\n${"// pad\n".repeat(40)}`);
  ok("code that does not parse is reported", /does not parse/.test(await c9("write_check", {})));

  // The other half: prose still gets the prose rules.
}

// --- the tail starts somewhere real -----------------------------------------
{
  const { boundaryTail, unbalanced } = await import(dist("pi/writing-tools.js"));
  const doc = `${"filler ".repeat(200)}\n## A Real Heading\n${"body ".repeat(60)}`;
  const t = boundaryTail(doc, 400);
  ok("the tail starts at a heading rather than mid-word", /^…\n## A Real Heading/.test(t));
  ok("a short file is returned whole", boundaryTail("short", 400) === "short");
  ok("with no boundary to find it still returns something", boundaryTail("x".repeat(900), 100).length > 50);

  ok("unbalanced brackets are noticed", /unclosed/.test(unbalanced("function f() { if (x) {") ?? ""));
  ok("balanced code is not", unbalanced("function f() { return [1, 2]; }") === undefined);
  ok("a brace inside a string is not counted", unbalanced('const s = "{";') === undefined);
  ok("a brace inside a comment is not counted", unbalanced("// {\nconst x = 1;") === undefined);
}

// --- task_finish must not eat a span write_next recorded --------------------
// The two tools share the tasks table on purpose, but write_next stores where
// the section landed and read_section/write_revise navigate by it. A model that
// wrote a section and then also called task_finish on it — one did, saying "the
// module has been written and verified" — replaced the span with prose, and the
// section quietly became unreachable.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  await createSession({ id: "w11", title: "w11", workspace, executor: "host" });
  const c11 = mount("w11", workspace);
  const taskCalls = {};
  taskTools("w11")({ on() {}, registerTool: (t) => (taskCalls[t.name] = t) });
  const t = async (name, args) => (await taskCalls[name].execute("id", args)).content[0].text;

  await c11("write_plan", { file: "spans.md", sections: ["One", "Two"] });
  await c11("write_next", { content: long("The first section.") });
  const before = (await listTasks("w11")).find((x) => x.seq === 1).result;

  const out = await t("task_finish", { step: 1, result: "written and verified" });
  ok("finishing an already-written section is refused politely", /already written and recorded/.test(out));
  const after = (await listTasks("w11")).find((x) => x.seq === 1).result;
  ok("and the span survives", after === before && /@\d+-\d+$/.test(after));
  ok("so the section can still be read back", /The first section/.test(await c11("read_section", { section: 1 })));
}

// --- the plan the model thought it had ------------------------------------
// A live run kept its own two-step task_plan in mind while write_plan silently
// replaced it with four sections, then called task_finish on "step 2" meaning
// something that no longer existed — and retried when refused.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  await createSession({ id: "w12", title: "w12", workspace, executor: "host" });
  const c12 = mount("w12", workspace);
  const tt = {};
  taskTools("w12")({ on() {}, registerTool: (t) => (tt[t.name] = t) });
  const t = async (name, args) => (await tt[name].execute("id", args)).content[0].text;

  await t("task_plan", { steps: ["think about it", "do it"] });
  const replaced = await c12("write_plan", { file: "replaced.md", sections: ["A", "B", "C"] });
  ok("replacing a plan is said out loud", /replaces the 2-step plan/.test(replaced));
  ok("and the old numbering is explicitly voided", /no longer mean anything/.test(replaced));

  await c12("write_next", { content: long("Section A.") });
  const refused = await t("task_finish", { step: 1, result: "all done" });
  ok("a refusal shows what the plan now is", /\[1\] A/.test(refused) && /\[3\] C/.test(refused));
}

// --- the shape it actually sent -------------------------------------------
// Asked to plan, a 26B model sent steps as objects with double-quoted keys —
// JSON inside JSON. The schema said "must be string", echoed the malformed
// arguments back, and it retried six times before recovering by accident.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  await createSession({ id: "w13", title: "w13", workspace, executor: "host" });
  const tt = {};
  taskTools("w13")({ on() {}, registerTool: (t) => (tt[t.name] = t) });
  const t = async (name, args) => (await tt[name].execute("id", args)).content[0].text;

  const out = await t("task_plan", {
    steps: [
      { '"step"': 1, '"description"': "Read the source" },
      { step: 2, description: "Write it up" },
    ],
  });
  ok("steps given as objects are understood", /Read the source/.test(out) && /Write it up/.test(out));
  ok("however the keys were quoted", /\[1\] Read the source/.test(out));
  ok("plain strings still work", /Write it up/.test(await t("task_plan", { steps: ["Write it up"] })));
  let threw = false;
  try { await t("task_plan", { steps: [{ step: 1 }] }); } catch { threw = true; }
  ok("something with no text in it is still refused", threw);
}

// --- a part-written plan is not re-planned ---------------------------------
// Working a plan step by step, the step's own context holds a file and a plan
// and no memory of having written either — so a live run called write_plan
// again, reset the four sections it was partway through, and stalled with
// nothing written. From inside that context it was a reasonable call.
{
  await createSession({ id: "w14", title: "w14", workspace, executor: "host" });
  const c14 = mount("w14", workspace);
  await c14("write_plan", { file: "guard.md", sections: ["One", "Two", "Three"] });
  await c14("write_next", { content: long("The first section.") });

  const refused = await c14("write_plan", { file: "guard.md", sections: ["Different", "Sections"] });
  ok("re-planning partway through is refused", /already partway through/.test(refused));
  ok("and it says where you actually are", /1 of 3 sections written/.test(refused) && /"Two" is next/.test(refused));
  ok("pointing at the tools that do work", /write_next/.test(refused) && /write_revise/.test(refused));
  ok("with the reason", /nothing describing it/.test(refused));

  const tasks = await listTasks("w14");
  ok("the existing plan is untouched", tasks.length === 3 && tasks[0].description === "One");
  ok("and the written section is still findable", /The first section/.test(await c14("read_section", { section: 1 })));

  // A plan nothing has been written against yet is a genuine re-plan.
  await createSession({ id: "w15", title: "w15", workspace, executor: "host" });
  const c15 = mount("w15", workspace);
  await c15("write_plan", { file: "fresh.md", sections: ["A", "B"] });
  ok("re-planning before anything is written is allowed",
     /Planned 3 section/.test(await c15("write_plan", { file: "fresh.md", sections: ["X", "Y", "Z"] })));
}

// --- the shape, shown rather than described --------------------------------
// A live run read "give steps as a list of plain strings" five times while
// building ever more elaborate nested objects, its own thinking quoting the
// schema prose back and guessing.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  const tt = {};
  taskTools("w15")({ on() {}, registerTool: (t) => (tt[t.name] = t) });

  ok("the description carries a literal call", /\{"steps": \[/.test(tt.task_plan.description));
  ok("and says steps must be followable by someone who was not there",
     /followed by someone who was not here/.test(tt.task_plan.description));
  // Sharpened once per-step isolation made it load-bearing: the step's own
  // text really is most of what the next context gets.
  ok("saying why — the step gets its own context", /context of its own/.test(tt.task_plan.description));
  ok("and forbids a step for planning", /Do not add a step for planning/.test(tt.task_plan.description));

  let message = "";
  try { await tt.task_plan.execute("id", { steps: [{ step: 1 }, {}] }); } catch (e) { message = e.message; }
  ok("the failure shows the shape rather than describing it", /\{"steps": \["Read the file/.test(message));
  ok("and names what it must not be", /Not objects, not numbered, not nested/.test(message));

  // Being liberal has a floor. The live run's objects were {"step": 1,
  // "description": 1} — no step text anywhere in them — and a plan containing
  // a step called "1" is worse than a refusal that shows the right shape.
  const mixed = await tt.task_plan.execute("id", { steps: [{ step: 1 }, { description: "Fix it" }] });
  ok("a step with text is kept and a bare index is not",
     /\[1\] Fix it/.test(mixed.content[0].text) && !/\[2\]/.test(mixed.content[0].text));
}

// --- write_next writes the section that is actually in hand ----------------
// task_start marks a step running; write_next looked only at pending, skipped
// it, and filed the text under the *next* section. Nothing errored — the plan
// simply stopped describing the file, and a live run lost a whole section.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  await createSession({ id: "w16", title: "w16", workspace, executor: "host" });
  const c16 = mount("w16", workspace);
  const tt16 = {};
  taskTools("w16")({ on() {}, registerTool: (t) => (tt16[t.name] = t) });

  await c16("write_plan", { file: "running.md", sections: ["area", "perimeter"] });
  await tt16.task_start.execute("id", {});
  await c16("write_next", { content: long("The area function.") });

  const rows = await listTasks("w16");
  ok("the running step is the one written", rows[0].status === "done" && /@0-/.test(rows[0].result));
  ok("and the next one is left alone", rows[1].status === "pending" && rows[1].result === "");
  ok("so it reads back as itself", /The area function/.test(await c16("read_section", { section: 1 })));
}

// --- a section is not finished because the model says it is ----------------
// Sisyphean's synthesizer carried an honesty rule and the audit dropped it,
// reasoning that under pi the answering model is the one that made the calls.
// Then a 26B model closed the "area" step with "I have completed the area
// function." and left the file empty.
{
  const { taskTools } = await import(dist("pi/task-tools.js"));
  await createSession({ id: "w17", title: "w17", workspace, executor: "host" });
  const c17 = mount("w17", workspace);
  const tt17 = {};
  taskTools("w17")({ on() {}, registerTool: (t) => (tt17[t.name] = t) });
  const t17 = async (n, a) => (await tt17[n].execute("id", a)).content[0].text;

  await c17("write_plan", { file: "honest.md", sections: ["area", "perimeter"] });
  const claimed = await t17("task_finish", { step: 1, result: "I have completed the area function." });
  ok("closing an unwritten section is refused", /nothing has been written for it/.test(claimed));
  ok("and it says the file would not have it", /the file does not contain it/.test(claimed));
  ok("pointing at the tool that actually writes", /write_next/.test(claimed));
  ok("and at the honest alternative", /write_skip/.test(claimed));
  ok("the step stays open", (await listTasks("w17"))[0].status === "pending");

  // A step that genuinely failed may still be recorded as failed.
  const failed = await t17("task_finish", { step: 1, result: "no formula for this shape", failed: true });
  ok("a failure can still be recorded", /Failed/.test(failed));

  // And outside a document, task_finish is unchanged: there is no file to
  // check a claim against.
  await createSession({ id: "w18", title: "w18", workspace, executor: "host" });
  const tt18 = {};
  taskTools("w18")({ on() {}, registerTool: (t) => (tt18[t.name] = t) });
  await tt18.task_plan.execute("id", { steps: ["look into it"] });
  const plain = await tt18.task_finish.execute("id", { step: 1, result: "looked into it" });
  ok("a step with no document behind it closes normally", /Done/.test(plain.content[0].text));
}

// --- a project is files, and files have an order ---------------------------
// write_plan plans the sections of one file; the same three arguments apply to
// six files, and one more that is specific to them: a module that imports from
// another has to be written after it, or the earlier file's real signatures are
// not there to match.
{
  await createSession({ id: "w19", title: "w19", workspace, executor: "host" });
  const c19 = mount("w19", workspace);

  const planned = await c19("write_project", {
    files: [
      { file: "tokens.mjs", purpose: "Token type and the TOKEN_KINDS table" },
      { file: "lexer.mjs", purpose: "tokenise(source) -> Token[], using tokens.mjs" },
    ],
  });
  ok("a project is planned", /Planned 2 file/.test(planned));
  ok("in the order given", planned.indexOf("tokens.mjs") < planned.indexOf("lexer.mjs"));
  ok("and planning hands off rather than starting", /Stop here/.test(planned));
  ok("the whole file is the unit, not the section", /the whole file, in one call/.test(planned));

  const rows = await listTasks("w19");
  ok("one step per file", rows.length === 2);
  ok("carrying its purpose", /TOKEN_KINDS/.test(rows[0].description));

  // A file is written whole. Appending would put the second file inside the
  // first, and the span bookkeeping describes offsets in one document.
  const first = await c19("write_next", { content: `export const TOKEN_KINDS = ["num", "op"];\n${"// pad\n".repeat(40)}` });
  ok("the file is written whole", /Wrote tokens\.mjs/.test(first));
  ok("and the next one is named", /lexer\.mjs/.test(first));

  const after = await listTasks("w19");
  ok("the step records the file, not a span", /chars in tokens\.mjs/.test(after[0].result));

  const session = await getSession("w19");
  ok("and the target moves to the next file", /lexer\.mjs$/.test(session.writing_file));
  ok("in the same directory", session.writing_file.includes(path.dirname(session.writing_file)));

  const second = await c19("write_next", { content: `import { TOKEN_KINDS } from "./tokens.mjs";\n${"// pad\n".repeat(40)}` });
  ok("the last file completes the project", /project is complete/.test(second));

  // A file too short to be a file is refused, as a section would be.
  await createSession({ id: "w20", title: "w20", workspace, executor: "host" });
  const c20 = mount("w20", workspace);
  await c20("write_project", { files: [{ file: "a.mjs", purpose: "does a thing" }] });
  ok("a one-line file is refused", /too short for a whole file/.test(await c20("write_next", { content: "x" })));

  let threw = false;
  try { await c20("write_project", { files: [] }); } catch { threw = true; }
  ok("a project with no files is refused with the shape", threw);
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
