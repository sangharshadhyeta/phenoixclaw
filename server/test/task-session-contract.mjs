/**
 * The agent starting its own work.
 *
 * The portal had no way to do this: sessions were created by a person, through
 * a form, with a title they typed and a workspace they picked — so every
 * substantial task had to be set up by hand, and the conversation you were
 * having and the work you were asking for were the same window.
 *
 * BirdClaw had it the other way round and it is the better shape: the chat is
 * one place you talk to the agent, and the agent decides when something has
 * become a task, gives it an id and a workspace of its own, and reports back.
 *
 *     npm run test:task-sessions
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { taskSessionTools, workspaceFor, briefIsUsable } = await import(dist("pi/task-session-tools.js"));
const { getSession } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const root = mkdtempSync(path.join(tmpdir(), "tasks-"));
const started = [];
let n = 0;

const tools = {};
taskSessionTools({
  workspaceRoot: root,
  executor: "host",
  newId: () => `child${++n}`,
  start: async (id, instructions) => { started.push({ id, instructions }); },
})({ on() {}, registerTool: (t) => (tools[t.name] = t) });

const call = async (name, args) => (await tools[name].execute("id", args)).content[0].text;

// --- naming and isolation ---------------------------------------------------
{
  // Titles collide — "notes" twice is two pieces of work in one folder — and
  // the isolation the guard enforces is only as good as the directory it gets.
  ok("the workspace is named from the id, not the title",
     workspaceFor("/w", "abc123") === path.join("/w", "session-abc123"));
}

// --- starting one -----------------------------------------------------------
{
  const out = await call("start_task", {
    title: "write the parser",
    instructions: "Write a tokeniser in src/lexer.mjs that handles numbers and operators, and test it.",
  });
  ok("it says what was started", /write the parser/.test(out));
  ok("naming the session", /child1/.test(out));
  ok("and where it is working", out.includes(root));
  // The whole point: the conversation carries on.
  ok("and that it is not being waited for", /not waiting for it/.test(out));

  const row = await getSession("child1");
  ok("the session exists", Boolean(row));
  ok("as a task", row.kind === "task");
  ok("with a workspace of its own", row.workspace === workspaceFor(root, "child1"));
  ok("which was actually created", existsSync(row.workspace));

  ok("and the work was handed over", started.length === 1 && started[0].id === "child1");
  ok("with the brief, not the conversation", /tokeniser/.test(started[0].instructions));
}

// --- what it refuses --------------------------------------------------------
{
  // The session that reads them cannot see the conversation they came from.
  ok("a brief too short to act on is not usable", !briefIsUsable("do it"));
  ok("a real one is", briefIsUsable("Write a tokeniser in src/lexer.mjs and test it."));

  let threw = "";
  try { await call("start_task", { title: "x", instructions: "do it" }); } catch (e) { threw = e.message; }
  ok("a thin brief is refused", /too short to act on/.test(threw));
  ok("saying why it matters", /cannot see this conversation/.test(threw));

  let noTitle = false;
  try { await call("start_task", { instructions: "a".repeat(40) }); } catch { noTitle = true; }
  ok("and work with no name is refused", noTitle);
}

// --- seeing what is in flight -----------------------------------------------
{
  const listing = await call("tasks_running", {});
  ok("started work is listed", /write the parser/.test(listing));
  ok("with its id, so it can be opened", /child1/.test(listing));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
