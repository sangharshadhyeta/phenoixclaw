/**
 * Which tools a step may use, while the portal is driving one.
 *
 * BirdClaw scoped tools by stage type and Sisyphean by keyword overlap down to
 * four, and the audit dropped both as compensation for a model that loses focus
 * with more than a handful. That was right about the mechanism and missed that
 * scoping is not only about focus: a step being driven is inside a plan the
 * portal is executing, and a few tools are not merely unhelpful there — they
 * act on the plan that is mid-execution.
 *
 * Every entry is a failure watched in a live run, so this checks that each one
 * is refused with the reason, and that nothing else is.
 *
 *     npm run test:driving
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const d = await import(path.join(here, "..", "dist", "pi", "driving.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- the three that act on the plan itself ----------------------------------
{
  // A step's context holds a file and a plan and no memory of writing either,
  // so re-planning is a reasonable call from inside. A live run reset four
  // sections and stalled with nothing written.
  ok("write_plan is refused", /partway through a plan/.test(d.drivenDenial("write_plan") ?? ""));
  ok("write_project too", /partway through a plan/.test(d.drivenDenial("write_project") ?? ""));
  ok("task_plan, because rewriting renumbers the step being worked",
     /renumbers the step you are on/.test(d.drivenDenial("task_plan") ?? ""));
  // task_start marked step 1 running, write_next looked only at pending, and
  // the area function was filed under perimeter.
  ok("task_start, because the runner already marked it",
     /already marked as in progress/.test(d.drivenDenial("task_start") ?? ""));
  ok("and it says what goes wrong", /recorded against the wrong one/.test(d.drivenDenial("task_start") ?? ""));

  // A refusal that only says no leaves the model with nothing to do.
  for (const tool of ["write_plan", "task_plan", "task_start"]) {
    ok(`${tool}'s refusal says what to do instead`, /\b(Write this part|Do this step|do the work)\b/.test(d.drivenDenial(tool)));
  }
}

// --- everything else is untouched -------------------------------------------
// A short denylist, not an allowlist: the turn was asked for, by us, and the
// risk is precisely bounded — it is the plan, and only the plan.
{
  for (const tool of [
    "write_next", "write_revise", "read_section", "write_check", "write_skip", "task_finish",
    "read", "grep", "find", "ls", "bash", "web_search", "graph_recall", "graph_remember",
    "expected_outcome", "report", "ask_primary",
  ]) {
    ok(`${tool} is not refused`, d.drivenDenial(tool) === undefined);
  }
}

// --- only while actually driving --------------------------------------------
{
  ok("a session nobody is driving is not marked", !d.isDriving("s1"));
  ok("undefined is never driving", !d.isDriving(undefined));

  d.beginDriving("s1");
  ok("a driven session is marked", d.isDriving("s1"));
  ok("and only that one", !d.isDriving("s2"));

  // The extend turn lifts the drive deliberately — it is the one turn that is
  // supposed to rewrite the plan — so this has to be reversible.
  d.endDriving("s1");
  ok("the drive can be lifted", !d.isDriving("s1"));
  d.beginDriving("s1");
  ok("and taken back", d.isDriving("s1"));
  d.endDriving("s1");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
