/**
 * The search query is what the person said, not what the portal appended.
 *
 * Asked "what is the square root of 144?", the recall ran against that
 * question plus three paragraphs of arithmetic note, and handed the turn a
 * fact node named `25` left over from a previous `100/4`, plus `first 20
 * primes` — while it was trying to produce a number.
 */
import { asked } from "../dist/pi/asked.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const NOTE = `

# THERE IS ARITHMETIC IN THIS

Work it out with \`bash\` and read the answer off. Do not do it in your head, however small it looks:
asked for 17 times 23, you have answered 393 in one word, with no working. It is 391.`;

ok("the arithmetic note is taken off",
   asked("what is the square root of 144?" + NOTE) === "what is the square root of 144?");
ok("and the world-question note",
   asked("who won in 1998?\n\n# THIS ASKS FOR A FACT ABOUT THE WORLD\n\nTry `graph_recall` first.")
     === "who won in 1998?");
ok("and the bare-referent note",
   asked("do that again\n\n# BEFORE YOU START\n\nThere is no earlier turn.") === "do that again");

ok("a portal block and everything after it goes",
   asked("ship it\n\n<portal-notice>A session has been started (abc).</portal-notice>") === "ship it");
ok("an unclosed opener still marks the boundary",
   asked("ship it\n\n<portal-result>The session working on") === "ship it");

ok("an ordinary message is untouched",
   asked("what is the capital of Peru?") === "what is the capital of Peru?");
ok("a hash that is not one of ours stays",
   asked("fix # 12 in the tracker") === "fix # 12 in the tracker");
ok("a heading of the user's own is kept",
   asked("read this:\n\n# THE PLAN\n\nstep one") === "read this:\n\n# THE PLAN\n\nstep one");

ok("untrusted markers are not part of the question",
   !/untrusted/.test(asked("summarise <<<untrusted:a1b2>>>hello<<<untrusted:a1b2>>>")));

/**
 * A message that is entirely ours still has to search for something. An empty
 * query matches everything and ranks by nothing.
 */
const allOurs = "<portal-check>\nThis is the portal, not the person.\n</portal-check>";
ok("a message that is all portal falls back to itself", asked(allOurs) === allOurs);
ok("empty in, empty out", asked("") === "");
ok("null is survivable", asked(undefined) === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
