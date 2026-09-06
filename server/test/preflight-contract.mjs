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
const { hasBareReferent, preflightNote, hasArithmetic, arithmeticNote, isWorldQuestion, worldQuestionNote, LOOKUP_TOOLS } = await import(path.join(here, "..", "dist", "pi", "preflight.js"));

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

// --- arithmetic the model will otherwise do in its head ---------------------
// BirdClaw's run_command route sent computation to a shell. This port claimed
// the standing practice covered it — "Arithmetic ... put them through `bash`",
// stated before the first token, with the reason attached. Asked "What is 17
// times 23?", a session with that practice in its prompt and bash in its tools
// answered 393, in one word, with no tool call. It is 391.
{
  ok("a bare product", hasArithmetic("What is 17 times 23?"));
  ok("with symbols", hasArithmetic("compute 144 * 12"));
  ok("division", hasArithmetic("what is 1024 / 16"));
  ok("a percentage", hasArithmetic("what is 15% of 240"));
  ok("addition in words", hasArithmetic("2 plus 2"));

  // Numbers that are not sums. The rule is narrow on purpose: an operator
  // *between* two numbers.
  ok("a port number is not a sum", !hasArithmetic("start the portal on 8101"));
  ok("nor a count of sections", !hasArithmetic("write three sections and 2 appendices"));
  ok("nor a version", !hasArithmetic("check whether we are on 1.4.4 or later"));
  ok("nor a date", !hasArithmetic("what happened on 2026-09-06"));
  ok("nor a path", !hasArithmetic("read src/pi/guard.ts and summarise"));
  ok("nor an ordinary question", !hasArithmetic("what is in the memory graph?"));

  const note = arithmeticNote("What is 17 times 23?");
  ok("the note names the tool", /`bash`/.test(note));
  ok("closes off 'it is small enough'", /however small it looks/.test(note));
  // The evidence, because a rule the model has already reasoned past needs to
  // be shown that it did.
  ok("and cites the failure that produced it", /393/.test(note) && /391/.test(note));
  ok("saying why fluency is the problem", /confidence of a right one/.test(note));
  ok("a request with no arithmetic says nothing", arithmeticNote("write the guide") === "");
}

// --- a question about the world --------------------------------------------
// The prompt says to check rather than recall and lands unreliably: asked the
// capital of France, one session searched and one answered "I know this fact",
// same prompt and same minute. The one that searched answered *first* and
// confirmed afterwards, which is looking for agreement.
{
  ok("a capital", isWorldQuestion("What is the capital of France?"));
  ok("an author", isWorldQuestion("who wrote Middlemarch"));
  ok("a date", isWorldQuestion("when was Rust released"));
  ok("a quantity", isWorldQuestion("how many people live in Tokyo"));
  ok("a place", isWorldQuestion("where is the Eiffel Tower"));

  /**
   * Questions about *this* system are already answered by looking, and `read`
   * and `grep` are the looking. Sending the model to the web for what its own
   * grep would answer is worse than saying nothing.
   */
  ok("this repo is not the world", !isWorldQuestion("what is in this repo"));
  ok("nor a file's length", !isWorldQuestion("how many lines is guard.ts"));
  ok("nor the portal's own state", !isWorldQuestion("what is broken in the portal"));
  ok("nor its running sessions", !isWorldQuestion("how many sessions are running"));
  ok("nor who it works for", !isWorldQuestion("who is the primary user"));
  ok("nor an instruction that is not a question", !isWorldQuestion("read src/pi/guard.ts and summarise"));
  ok("a long message carries its own context", !isWorldQuestion(`who wrote this ${"x".repeat(320)}`));

  const note = worldQuestionNote("What is the capital of France?");
  ok("the note says to look first", /Look it up before you answer/.test(note));
  // The specific trap: answering and then searching reads whatever comes back
  // as confirmation, because the decision is already made.
  ok("and closes off answering then confirming", /not checking/.test(note) && /already decided/.test(note));
  ok("with the unverified label as the fallback", /labelled as\* from memory|labelled/.test(note));
  ok("a local question gets no note", worldQuestionNote("what is in this repo") === "");

  /**
   * What counts as having looked. `read`, `grep` and `bash` are absent on
   * purpose: a session that greps its own workspace for the capital of France
   * has checked nothing, which is `echo "Paris" | grep -v "Paris"` in another
   * costume.
   */
  ok("searching counts", LOOKUP_TOOLS.has("web_search"));
  ok("so does its own memory", LOOKUP_TOOLS.has("graph_recall"));
  ok("grepping the workspace does not", !LOOKUP_TOOLS.has("grep"));
  ok("nor reading a local file", !LOOKUP_TOOLS.has("read"));
  ok("nor running a command", !LOOKUP_TOOLS.has("bash"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
