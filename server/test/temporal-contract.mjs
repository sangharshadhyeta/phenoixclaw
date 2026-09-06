/**
 * Knowing when now is, and pinning relative dates while they still mean
 * something.
 *
 * Nothing told the agent the date. Asked directly it answered "Friday,
 * September 5, 2026" on Sunday the 6th — it had inferred yesterday from a
 * memory node's timestamp and guessed the weekday wrong on top. Every temporal
 * question rests on this: "you have a meeting on Thursday" is useless if you
 * cannot tell whether that Thursday has been and gone.
 *
 *     npm run test:temporal
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { nowBlock, nextWeekday, temporalContext } = await import(dist("pi/temporal-context.js"));
const { pinDates } = await import(dist("harvest.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// Sunday 2026-09-06, the day the agent got wrong.
const SUNDAY = new Date("2026-09-06T10:30:00Z");

// --- the agent is told when now is ----------------------------------------
{
  const block = nowBlock(SUNDAY);
  ok("the date is stated", /2026-09-06/.test(block));
  ok("and the weekday with it", /Sunday/.test(block));
  ok("the coming week is named so no arithmetic is needed", /Thursday 2026-09-10/.test(block));
  ok("today is not listed as its own next occurrence", !/Sunday 2026-09-06/.test(block));
  ok("it is told a passed date is not still ahead", /now past is not still ahead/.test(block));
  ok("and to say so rather than repeat it", /rather than\s+repeating it/.test(block));
}

// --- weekday resolution ----------------------------------------------------
{
  ok("Thursday after Sunday is four days on",
     nextWeekday(SUNDAY, 4).toISOString().slice(0, 10) === "2026-09-10");
  ok("the same weekday means next week, not today",
     nextWeekday(SUNDAY, 0).toISOString().slice(0, 10) === "2026-09-13");
}

// --- dates pinned at the moment of recording -------------------------------
{
  const pinned = pinDates("I have a meeting on Thursday", SUNDAY);
  ok("a bare weekday gains its real date", /Thursday \(2026-09-10\)/.test(pinned));
  ok("and keeps the original wording for search", /meeting on Thursday/.test(pinned));

  ok("'last Thursday' resolves backwards",
     /Thursday \(2026-09-03\)/.test(pinDates("we discussed it last Thursday", SUNDAY)));
  ok("text with no weekday is untouched",
     pinDates("the build takes ninety seconds", SUNDAY) === "the build takes ninety seconds");
  ok("a weekday inside a word is not matched",
     pinDates("Thursdays are busy", SUNDAY) === "Thursdays are busy");
}

// --- it runs every turn, not once per session ------------------------------
{
  let handler;
  let tick = new Date("2026-09-06T10:00:00Z");
  temporalContext(() => tick)({ on: (e, fn) => { if (e === "before_agent_start") handler = fn; }, registerTool() {} });

  const first = await handler({ type: "before_agent_start", prompt: "hello", systemPrompt: "BASE" });
  ok("the date is appended to the prompt", /2026-09-06/.test(first.systemPrompt));
  ok("and the assembled prompt is kept", first.systemPrompt.startsWith("BASE"));

  // A conversation left open overnight must not insist it is still yesterday.
  tick = new Date("2026-09-07T09:00:00Z");
  const later = await handler({ type: "before_agent_start", prompt: "still there?", systemPrompt: "BASE" });
  ok("a later turn gets the new date", /2026-09-07/.test(later.systemPrompt));
  ok("and not the old one", !/2026-09-06/.test(later.systemPrompt));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
