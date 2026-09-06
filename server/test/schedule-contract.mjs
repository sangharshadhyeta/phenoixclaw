/**
 * `every:N` — intervals, which cron cannot express.
 *
 * Cron says "at these times", not "this often". A step of two in the hour field
 * is every two hours only because two divides twenty-four; ninety minutes has
 * no cron expression at all. BirdClaw carried `every:N` for exactly this.
 *
 *     npm run test:schedule
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { parseEvery, nextEvery, isEveryDue, isValidCron, parseCron } = await import(dist("routines/cron.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- what it accepts -------------------------------------------------------
ok("bare minutes", parseEvery("every:10") === 10);
ok("explicit minutes", parseEvery("every:10m") === 10);
ok("hours", parseEvery("every:2h") === 120);
ok("days", parseEvery("every:1d") === 1440);
ok("the interval cron cannot express", parseEvery("every:90m") === 90);
ok("spelled out", parseEvery("every: 45 minutes") === 45);
ok("case is not significant", parseEvery("EVERY:3H") === 180);

// --- and what it does not --------------------------------------------------
ok("a cron expression is not an interval", parseEvery("0 * * * *") === undefined);
ok("nor is a shorthand", parseEvery("@hourly") === undefined);
ok("nor a quiet schedule", parseEvery("@continuous") === undefined);
ok("zero is refused", parseEvery("every:0") === undefined);
ok("and so is nonsense", parseEvery("every:soon") === undefined);

// --- when it fires ---------------------------------------------------------
{
  const now = new Date("2026-09-06T12:00:00Z");

  // Never run: due now rather than one interval away. Somebody who asks for
  // "every ten minutes" expects the first one soon.
  ok("a routine that has never run is due", isEveryDue(10, now, null));
  ok("and its next firing is now", nextEvery(10, null, now).getTime() === now.getTime());

  const justRan = new Date("2026-09-06T11:55:00Z");
  ok("five minutes into a ten-minute interval is not due", !isEveryDue(10, now, justRan));
  ok("and the next firing is measured from the last run",
     nextEvery(10, justRan).toISOString() === "2026-09-06T12:05:00.000Z");

  const longAgo = new Date("2026-09-06T09:00:00Z");
  ok("three hours into a ninety-minute interval is due", isEveryDue(90, now, longAgo));
  ok("exactly on the boundary is due",
     isEveryDue(10, now, new Date("2026-09-06T11:50:00Z")));
}

// --- it must be accepted where a person types it ---------------------------
// A schedule the tick understands and the API rejects is a feature that works
// everywhere except the one place it is entered.
ok("the validator accepts an interval", isValidCron("every:90m") === null);
ok("and still rejects nonsense", isValidCron("not a schedule") !== null);
ok("while cron keeps working", isValidCron("0 * * * *") === null);
ok("as do shorthands", isValidCron("@daily") === null);

// --- and the tick and preview both know about it ---------------------------
{
  const { readFileSync } = await import("node:fs");
  const sup = readFileSync(new URL("../src/routines/supervisor.ts", import.meta.url), "utf8");
  ok("the tick checks for an interval before parsing cron",
     sup.indexOf("parseEvery(row.schedule)") < sup.indexOf("cron = parseCron(row.schedule)"));
  ok("and whenNext can predict one", /nextEvery\(everyMinutes/.test(sup));

  const api = readFileSync(new URL("../src/api/routines.ts", import.meta.url), "utf8");
  ok("the preview endpoint handles one", /parseEvery\(schedule\)/.test(api));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
