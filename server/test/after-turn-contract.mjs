/**
 * Checking, afterwards, that the turn did what it was told.
 *
 * Every standing practice here was first written as prose and every one was
 * reasoned past — a module of four functions is not a book, seventeen times
 * twenty-three is small, the capital of France is a thing I know. None of that
 * is disobedience: each is a particular case that genuinely feels like an
 * exception, decided mid-generation with the rest of the task competing for
 * attention. A rule that must be remembered at exactly the wrong moment is a
 * hope, not a rule.
 *
 * The two that stuck became mechanical. This is that move made general: look
 * at what the turn *did*, compare it with what the request *asked for*, and
 * hand it back where they disagree.
 *
 *     npm run test:after-turn
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { failedCheck, selfConfirming, AFTER_TURN_CHECKS } = await import(
  path.join(here, "..", "dist", "pi", "after-turn.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };
const call = (toolName, args = {}) => ({ toolName, args: JSON.stringify(args) });

// --- a world question answered from memory ----------------------------------
{
  const q = "What is the capital of France?";
  ok("answering with no lookup is handed back", failedCheck(q, [])?.name === "world-question-unchecked");
  ok("searching satisfies it", failedCheck(q, [call("web_search", { query: "capital of France" })]) === undefined);
  ok("so does its own memory", failedCheck(q, [call("graph_recall", { query: "France" })]) === undefined);

  // A session that greps its workspace for the capital of France has checked
  // nothing — the same failure in another costume.
  ok("grepping the workspace does not", failedCheck(q, [call("grep", { pattern: "Paris" })])?.name === "world-question-unchecked");
  ok("nor reading a local file", failedCheck(q, [call("read", { path: "notes.md" })])?.name === "world-question-unchecked");

  const message = failedCheck(q, []).message;
  ok("the hand-back names the tools", /web_search/.test(message) && /graph_recall/.test(message));
  ok("and allows an honest failure", /label the answer unverified/.test(message));
  ok("a local question is never handed back", failedCheck("what is in this repo", []) === undefined);
}

// --- arithmetic done in the head --------------------------------------------
{
  const q = "What is 17 times 23?";
  ok("no bash is handed back", failedCheck(q, [])?.name === "arithmetic-in-head");
  ok("bash satisfies it", failedCheck(q, [call("bash", { command: "echo $((17*23))" })]) === undefined);
  ok("a lookup does not substitute for computing", failedCheck(q, [call("web_search", {})])?.name === "arithmetic-in-head");
  ok("and a question with no sum is left alone", failedCheck("write the guide", []) === undefined);
}

// --- a check that cannot disagree -------------------------------------------
{
  ok("echoing a literal is self-confirming", selfConfirming('echo "Paris" | grep -v "Paris"'));
  ok("even without the pipe", selfConfirming('echo "Paris"'));
  // An arithmetic expansion computes something the model did not know.
  ok("an expansion is not", !selfConfirming("echo $((17*23))"));
  ok("nor a command substitution", !selfConfirming('echo "$(date)"'));
  ok("nor echoing into something that reads the world", !selfConfirming('echo "x" && curl -s https://example.test'));
  ok("nor an ordinary command", !selfConfirming("ls -la"));

  const failed = failedCheck("anything at all", [call("bash", { command: 'echo "Paris" | grep -v "Paris"' })]);
  ok("performing a check is handed back", failed?.name === "self-confirming-check");
  ok("with the reason", /can only ever agree with what went in/.test(failed.message));
  // And the honest alternative, since the model may simply not have needed to
  // check at all.
  ok("and the alternative to performing one", /do not perform\s+checking/.test(failed.message));

  ok("a real command is not handed back",
     failedCheck("anything at all", [call("bash", { command: "npm test" })]) === undefined);
}

// --- shape ------------------------------------------------------------------
{
  ok("every check says what it is", AFTER_TURN_CHECKS.every((c) => c.name && c.message));
  ok("and every message is long enough to act on", AFTER_TURN_CHECKS.every((c) => c.message.length > 120));
  // A turn with nothing wrong is never interrupted.
  ok("a sound turn passes", failedCheck("write the guide", [call("write_next", {})]) === undefined);
  /**
   * A bash call whose arguments will not parse still happened. Reading it as a
   * real computation is the lenient choice and the right one: the alternative
   * is handing back a turn that may well have done exactly what was asked,
   * because the portal could not read its own event log.
   */
  let threw = false;
  let verdict;
  try {
    verdict = failedCheck("What is 17 times 23?", [{ toolName: "bash", args: "not json" }]);
  } catch {
    threw = true;
  }
  ok("malformed args do not throw", !threw);
  ok("and are given the benefit of the doubt", verdict === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
