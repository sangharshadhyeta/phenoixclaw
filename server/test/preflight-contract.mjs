/**
 * A request whose referent is not there.
 *
 * BirdClaw's soul layer routed each message to one of four actions, and the
 * audit dropped it as small-model scaffolding — right about the mechanism, a
 * grammar-constrained routing JSON exists because a 4B model cannot decide and
 * act in one generation. Three of the four routes already exist here in better
 * form. `escalate` does not, and its condition is the checkable one: "vague
 * pronoun reference without prior context".
 *
 * The risk is false positives on ordinary terse requests, so most of this is
 * about what it must leave alone.
 *
 *     npm run test:preflight
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { hasBareReferent, preflightNote } = await import(path.join(here, "..", "dist", "pi", "preflight.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- messages that are nothing but a pointer --------------------------------
{
  ok("fix it", hasBareReferent("fix it"));
  ok("do that again", hasBareReferent("do that again"));
  ok("run it", hasBareReferent("run it"));
  ok("it failed", hasBareReferent("it failed"));
  ok("that is still broken", hasBareReferent("That is still broken"));
  ok("again", hasBareReferent("again"));
  ok("same", hasBareReferent("same"));
  ok("what about it?", hasBareReferent("what about it?"));
  ok("continue that", hasBareReferent("continue that"));
}

// --- what it must leave alone -----------------------------------------------
// A request that carries its own context is not a bare referent, however many
// pronouns it contains. Blocking a merely terse request would be worse than
// the guess this prevents.
{
  ok("a request naming its target", !hasBareReferent("fix the parser in src/lexer.ts"));
  ok("a pronoun with the context around it",
     !hasBareReferent("The build fails on the arm runner. Check whether it compiles with node 20."));
  ok("an ordinary question", !hasBareReferent("what is in the graph about deployments?"));
  ok("a long message is assumed to carry its own context",
     !hasBareReferent(`Please look at ${"the deployment pipeline ".repeat(15)} and fix it`));
  ok("an empty message is not flagged", !hasBareReferent(""));
  ok("a greeting is not flagged", !hasBareReferent("hi"));
  ok("naming a file called 'it' is not a referent", !hasBareReferent("read it.md and summarise"));
}

// --- when it fires ----------------------------------------------------------
{
  // The whole point: the same message is fine once there is something for it
  // to point at.
  ok("with earlier turns, nothing is said", preflightNote("fix it", true) === "");
  ok("without them, something is", preflightNote("fix it", false) !== "");
  ok("a clear request says nothing either way",
     preflightNote("fix the parser in src/lexer.ts", false) === "");

  const note = preflightNote("fix it", false);
  ok("it says what is missing", /nothing earlier in/.test(note));
  // The specific trap: memory is full of plausible referents, and the closest
  // match is not the same as knowing what was meant.
  ok("and warns that memory will supply a plausible one", /will find something in your memory/.test(note));
  ok("naming the failure it prevents", /the wrong thing to the wrong file/.test(note));
  ok("it offers asking or stating the assumption", /ask what is meant/.test(note) && /which thing you are assuming/.test(note));
  ok("and does not block a genuinely obvious case", /if it genuinely is obvious/i.test(note));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
