/**
 * A step has to be followable by someone who was not there.
 *
 * Sisyphean's decomposer put this as a writing rule — BAD: "Continue the
 * previous work", GOOD: "Run `python scraper.py --url …` and check stdout for
 * ≥5 titles" — and the audit kept the machinery question and lost the rule.
 *
 * It matters more here than it did there. Each step now runs in a context
 * holding the plan and what earlier steps produced, so the step's own text is
 * most of what the next turn has. "Continue the refactor" was recoverable when
 * the whole conversation was still present; it is not now, and it fails
 * silently — the model writes something plausible for a step it cannot resolve.
 *
 * The detection is a word list, so most of what follows is about the false
 * positives it must not produce.
 *
 *     npm run test:step-text
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { backReferences, selfContainmentNote } = await import(path.join(here, "..", "dist", "pi", "step-text.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };
const flagged = (s) => backReferences([s]).length === 1;

// --- what it must catch -----------------------------------------------------
{
  ok("continue the previous work", flagged("Continue the previous work"));
  ok("resume where we left off", flagged("Resume where we left off"));
  ok("the previous step", flagged("Apply the same fix to the previous step"));
  ok("as above", flagged("Document it as above"));
  ok("finish it", flagged("Finish it off"));
  ok("do the same", flagged("Do the same for the other module"));
  ok("a step that starts mid-sentence", flagged("Then run the tests"));
  ok("Sisyphean's own bad example", flagged("Continue the previous work"));
  ok("and its good one is left alone",
     !flagged("Run `python scraper.py --url https://x.test` and check stdout for at least 5 titles"));
}

// --- what it must not catch -------------------------------------------------
// A word list cannot tell "continue the refactor" from "add a Continue button",
// which is exactly why this warns rather than refuses.
{
  ok("a Continue button is not a back-reference", !flagged("Add a Continue button to the checkout form"));
  ok("nor a continue integration", !flagged("Wire up the continue integration endpoint"));
  ok("an ordinary imperative step is fine", !flagged("Write the rollback section"));
  ok("so is one naming a file and a command", !flagged("Run npm test -w server and fix what fails"));
  ok("and one that merely contains 'last'", !flagged("Return the last element of the array"));
  ok("and one about previous versions of a document", !flagged("Compare against the previous release notes"));
  ok("an empty plan flags nothing", backReferences([]).length === 0);
}

// --- how it is put ----------------------------------------------------------
{
  ok("a sound plan says nothing at all", selfContainmentNote(["Write the intro", "Write the body"]) === "");

  const note = selfContainmentNote(["Read src/parser.ts", "Continue the previous work", "Finish it off"]);
  ok("the vague steps are named", /Continue the previous work/.test(note) && /Finish it off/.test(note));
  ok("by their number in the plan", /\[2\]/.test(note) && /\[3\]/.test(note));
  ok("the sound one is not", !/Read src\/parser\.ts/.test(note));
  ok("each says what is missing", /continue what\?/.test(note) && /finish what\?/.test(note));

  // The reason, because a rule without one gets followed to the letter and
  // missed in spirit.
  ok("it says why the step stands alone", /context of its own/.test(note));
  ok("and shows what better looks like", /npm test -w server/.test(note));
  // It warns; it does not refuse. The plan was already set by the time this
  // is read.
  ok("and leaves the judgement with the model", /if they read fine to you as they are, carry on/.test(note));

  // Reported once per step, not once per matching phrase.
  ok("a step matching twice is reported once",
     backReferences(["Continue the previous step as above"]).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
