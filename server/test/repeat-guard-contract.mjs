/**
 * The same call, over and over, stopped rather than noticed.
 *
 * A learning-loop iteration made 106 tool calls in one turn, about a hundred of
 * them `task_start` with no arguments. `repetition()` in supervisor.ts sees
 * this and *says so*, which cannot help: it runs in the background and lands on
 * a later request, by which time the turn has spent itself.
 *
 * A loop is one of the few things unambiguous from the outside — same tool,
 * same arguments, same answer — so it needs no judgement, only a stop.
 *
 *     npm run test:repeat-guard
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { tooManyRepeats, resetRepeats, repeatRefusal } = await import(
  path.join(here, "..", "dist", "pi", "repeat-guard.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- counting ---------------------------------------------------------------
{
  resetRepeats("s1");
  const r = [];
  for (let i = 0; i < 5; i++) r.push(tooManyRepeats("s1", "task_start", {}));
  ok("a few retries are allowed", r.slice(0, 3).every((x) => !x));
  ok("and then it stops", r[3] === true && r[4] === true);

  // Different arguments is work, not a loop.
  resetRepeats("s2");
  for (let i = 0; i < 5; i++) tooManyRepeats("s2", "read", { path: `f${i}.ts` });
  ok("the same tool on different arguments is not a loop",
     !tooManyRepeats("s2", "read", { path: "another.ts" }));

  // Per turn: reading the same file in two turns is ordinary.
  resetRepeats("s1");
  ok("a new turn starts clean", !tooManyRepeats("s1", "task_start", {}));

  resetRepeats("s3");
  ok("sessions are counted apart", !tooManyRepeats("s3", "task_start", {}));

  // Unserialisable arguments must not throw.
  resetRepeats("s4");
  const circular = {};
  circular.self = circular;
  let threw = false;
  try { tooManyRepeats("s4", "x", circular); } catch { threw = true; }
  ok("arguments that will not serialise do not throw", !threw);
}

// --- what it says -----------------------------------------------------------
{
  const text = repeatRefusal("task_start");
  ok("it names the tool", /`task_start`/.test(text));
  ok("and says why another go cannot help", /will not be different/.test(text));
  // Otherwise the model has nowhere to go but the same call.
  ok("it offers stopping as a real answer", /an account of a\s+wall is a real answer/.test(text));
}

// --- the root cause, not only the symptom -----------------------------------
{
  const tools = readFileSync(new URL("../src/pi/task-tools.ts", import.meta.url), "utf8");
  // "Nothing pending" was true, read as a success, and suggested nothing.
  ok("a finished plan says another start cannot help", /cannot change/.test(tools));
  ok("and no plan says to write one first", tools.includes("Write one with"));

  const seeds = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  ok("the learning loop no longer instructs the ceremony that looped",
     !/"Call `task_start`, then do that step/.test(seeds));

  const mgr = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  // Blocking alone is not enough: the model still has the turn, and a hundred
  // refusals read much like a hundred dead ends.
  ok("a looping turn is ended, not merely refused",
     /Refused: you have called[\s\S]{0,400}client\.abort/.test(mgr));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
