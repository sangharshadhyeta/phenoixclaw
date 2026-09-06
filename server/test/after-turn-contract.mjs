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
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { failedCheck, selfConfirming, asksForWork, claimsImpossible, AFTER_TURN_CHECKS } = await import(
  path.join(here, "..", "dist", "pi", "after-turn.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };
const call = (toolName, args = {}) => ({ toolName, args: JSON.stringify(args) });

// --- a conversation asked to build something must hand it out --------------
// BirdClaw force-created the task in Python when routing failed — a decision
// the code made, not a prompt. Here the tool exists, is described, and was
// reasoned past three times: the model wrote the file into the agent's home,
// then into a workspace it did not own, and when both were refused it pasted
// the module into the reply and called nothing at all.
{
  const chat = { conversational: true };
  const task = { conversational: false };

  ok("building a module is work", asksForWork("Build me a small Python module called areas.py"));
  ok("so is writing a report", asksForWork("write a report on the deployment options"));
  ok("and fixing a file", asksForWork("fix the parser in lexer.ts"));

  // A question about work is still a question, and a conversation answers it.
  ok("a question is not work", !asksForWork("what does this module do?"));
  ok("nor is how-to", !asksForWork("how would I write a parser?"));
  ok("nor a greeting", !asksForWork("hi"));

  const q = "Build me a small Python module called areas.py with two functions.";
  ok("answering it in the chat is handed back",
     failedCheck(q, [], chat)?.name === "work-not-handed-out");
  ok("handing it out satisfies the check",
     failedCheck(q, [call("start_task", { title: "areas" })], chat) === undefined);
  // The failure mode is calling *no* tool, which a guard cannot intercept —
  // only an after-turn check sees what a turn did not do.
  ok("pasting code with no tool at all is caught", failedCheck(q, [], chat) !== undefined);
  ok("and writing the file itself does not count",
     failedCheck(q, [call("write", { path: "areas.py" })], chat)?.name === "work-not-handed-out");

  // A task session *is* the work; it must not be told to delegate its own job.
  ok("a task doing the work is left alone", failedCheck(q, [call("write", {})], task) === undefined);

  const message = failedCheck(q, [], chat).message;
  ok("the hand-back names the tool", /start_task/.test(message));
  ok("and says why a pasted module is not an answer", /produces no file/.test(message));
}

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
  ok("echoing a literal into a filter for it is self-confirming",
     selfConfirming('echo "Paris" | grep -v "Paris"'));
  /**
   * A bare echo is not.
   *
   * Flagging one told a live session it had performed verification theatre
   * when it had merely run a pointless command. It spent a whole turn agreeing
   * with an accusation that did not fit and drew a wrong conclusion about its
   * own behaviour — a false positive here costs more than what it watches for.
   */
  ok("a bare echo is only pointless, not a fake check",
     !selfConfirming('echo "exponent of the second largest known Mersenne prime"'));
  ok("nor is echoing into an unrelated filter", !selfConfirming('echo "x" | grep somethingelse'));
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

// --- declaring something impossible, having tried nothing ------------------
// Asked to multiply the two largest known primes, a session replied that the
// result "would exceed the storage and processing limits of any digital
// system" and gave a formula instead. Python does it in 77 seconds; the
// product has 66 million digits. Nothing was attempted — the claim was
// reasoning about feasibility, presented as a finding.
{
  const said = (reply) => ({ conversational: true, reply });
  const claim = "There is no way to display the actual decimal expansion of this number, as it " +
                "would exceed the storage and processing limits of any digital system.";
  const work = { conversational: false, reply: claim };

  ok("the claim is recognised", claimsImpossible(claim));
  ok("and its cousins", claimsImpossible("that is impossible") && claimsImpossible("it cannot be computed"));
  ok("an ordinary answer is not", !claimsImpossible("The capital of Peru is Lima."));
  // "I could not reach the search engine" is a finding, not a prediction.
  ok("nor is a report of something actually tried",
     !claimsImpossible("I ran it and the command was not found."));
  ok("nothing said is nothing to check", !claimsImpossible(undefined));

  ok("claiming it without trying is handed back",
     failedCheck("multiply these two", [], said(claim))?.name === "impossible-without-trying");
  // Anything that reaches the world counts as having tried.
  ok("having run something satisfies it, in a session",
     failedCheck("multiply these two", [call("bash", { command: "python3 -c ..." })], work) === undefined);
  ok("so does having searched",
     failedCheck("x", [call("web_search", {})], work) === undefined);

  const message = failedCheck("multiply these two", [], work).message;
  ok("it names the tool to try with", /`bash`/.test(message));
  ok("a failure is allowed, and counts", /that is a finding/.test(message));
  // The standing practice says being unable is a complete answer; this must
  // not contradict it.
  ok("the distinction is the wall you found versus the one you imagined",
     /only imagined it/.test(message));

  /**
   * In a conversation the remedy is different, because the tools are.
   *
   * A chat has no bash and no web_search — see excludeTools in sdk-client.ts.
   * Telling it to run one would be an instruction it can only fail, which is
   * the shape of every loop this file exists to stop. Trying is a session's
   * job, so handing out is what counts as having tried.
   */
  ok("in a conversation, handing it out is trying",
     failedCheck("multiply these two", [call("start_task", {})], said(claim)) === undefined);
  ok("and running something it cannot run does not count",
     failedCheck("multiply these two", [call("bash", {})], said(claim))?.name ===
       "impossible-without-trying");
  const chatMessage = failedCheck("multiply these two", [], said(claim)).message;
  ok("so the chat is told to start a session, not to open a shell",
     /`start_task`/.test(chatMessage) && !/`bash`/.test(chatMessage));

  ok("a turn that claims nothing is left alone",
     failedCheck("what is the capital of Peru", [call("graph_recall", {})], said("It is Lima.")) === undefined);
}

// --- a conversation that worked instead of talking -------------------------
// `work-not-handed-out` reads the request, and a live run walked past it:
// asked to multiply the two largest known primes, it ran six web searches and
// several bash calls in the chat and never started a session. The request was
// phrased as a question, so nothing matched. Wording was the wrong signal.
{
  const chat = { conversational: true };
  const task = { conversational: false };
  const many = (n, tool = "bash") => Array.from({ length: n }, (_, i) => call(tool, { i }));

  ok("a handful of calls is still a conversation", failedCheck("anything", many(3), chat) === undefined);
  ok("six is work", failedCheck("anything", many(6), chat)?.name === "work-done-in-the-conversation");
  ok("and it does not depend on how the request was worded",
     failedCheck("tell me how many digits that has", many(6), chat)?.name === "work-done-in-the-conversation");

  // Handing out is the right outcome however many calls it took.
  ok("having handed it out satisfies the check",
     failedCheck("anything", [...many(6), call("start_task", {})], chat) === undefined);
  ok("so does sending it to work already running",
     failedCheck("anything", [...many(6), call("tell_task", {})], chat) === undefined);

  // A conversation answering a question about itself is not working.
  ok("checking its own state is not work",
     failedCheck("how is that going?", many(8, "tasks_running"), chat) === undefined);
  ok("nor is reading its own memory", failedCheck("what do you know?", many(8, "graph_recall"), chat) === undefined);

  // A task session *is* the work.
  ok("a task doing many things is left alone", failedCheck("anything", many(20), task) === undefined);

  const message = failedCheck("anything", many(6), chat).message;
  ok("it says to give the answer anyway", /You have the answer now, so give it/.test(message));
  ok("and what to do next time", /hand it out first/.test(message));
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

// --- the checks judge this turn, not the session ----------------------------
// `recentToolCalls` returned the session's last N calls, and the checks read
// them as evidence about the turn. A conversation that answered "2 × 3 = 6"
// with no tool calls at all was handed back for "work done in the
// conversation", because six web searches from the previous question were
// still in the window. A check that decides from stale evidence is worse than
// no check: it is wrong in a way that reads as authoritative.
{
  const db = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  ok("tool calls can be scoped to a point in the log", /AND seq > \$sinceSeq/.test(db));
  ok("and the turn's start can be found", /export async function turnStartSeq/.test(db));
  ok("from the last thing that was asked", /type IN \('portal_prompt', 'portal_step'\)/.test(db));

  const mgr = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok("the after-turn check uses it", /turnStartSeq\(sessionId\)[\s\S]{0,200}recentToolCalls\(sessionId, 40, since\)/.test(mgr));

  /**
   * And a hand-back must not read as the person speaking. A live run replied
   * "I understand, for future work I should…" and thanked them for guidance
   * that was the portal's own check.
   */
  ok("a hand-back says who is talking", /<portal-check>/.test(mgr));
  ok("and that nobody asked it anything", /Nobody said this/.test(mgr));
}

// --- work the portal handed out is not work the model failed to hand out ----
// The request that makes the portal start a session by itself is exactly the
// request `work-not-handed-out` matches. Scolding the model for not doing what
// has already been done is a demand it cannot satisfy, which is the shape
// every loop in this file exists to stop.
{
  const asked = "write me a python script that prints the first 20 primes";
  ok("a build request with nothing done is handed back",
     failedCheck(asked, [], { conversational: true })?.name === "work-not-handed-out");
  ok("but not when the portal started the session itself",
     failedCheck(asked, [], { conversational: true, handedOut: true }) === undefined);
  const busy = Array.from({ length: 6 }, (_, i) => call("bash", { i }));
  ok("and the same holds for a chat that did a lot of work",
     failedCheck(asked, busy, { conversational: true, handedOut: true }) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
