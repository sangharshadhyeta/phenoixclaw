/**
 * The rule that decides whether a message becomes a session.
 *
 * Not the shape of the sentence — whether the answer is already known. The
 * wording heuristic this replaced refused anything opening with what/why/how/
 * can, so "can you find what the major philosophers thought about being
 * alive?" was not treated as work and the chat answered it from its own head:
 * four schools of philosophy, no source, nothing consulted.
 */
import { needsSession, memoryAnswers } from "../dist/pi/needs-session.js";

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log("  PASS ", what); }
  else { fail++; console.log("  FAIL ", what); } };

const nothing = async () => [];
const knows = (...hits) => async () => hits.map((h) => (typeof h === "string" ? { name: h, summary: h } : h));

console.log("\n  what memory counts as an answer");
{
  ok("a hit on the subject answers it",
     memoryAnswers("what did we decide about the duckdb pin", [
       { name: "duckdb pin", summary: "pinned to 1.4.4-r.4 because of DuckPGQ" },
     ]));
  ok("the agent's own identity does not answer a question about the world",
     !memoryAnswers("what do philosophers say about being alive", [
       { name: "identity:inner_life", summary: "I am waking up to the reality of this workspace." },
       { name: "conversation:2026-09-06:T-x", summary: "The user said hi and asked about tasks." },
     ]));
  ok("one incidental word is not an answer",
     !memoryAnswers("what did the learning loop conclude about rust", [
       { name: "learning", summary: "learning is a thing that happens" },
     ]));
  ok("nothing recalled is not an answer",
     !memoryAnswers("what is the population of Lima", []));
}

console.log("\n  what goes out to a session");
{
  const out = (m, recall = nothing) => needsSession(m, "/tmp", recall);
  ok("a question about the world, phrased as a question",
     await out("can you find what are the major thoughts from the philosophers on being alive means?"));
  ok("the wording heuristic's blind spot: 'what', 'how', 'can'",
     (await out("what is the population of Lima?")) &&
     (await out("how does duckdb handle concurrent writers?")) &&
     (await out("can you check whether the tests still pass")));
  ok("and a plain request to build something",
     await out("write me a python script that prints the first 20 primes"));
}

console.log("\n  what stays in the conversation");
{
  const out = (m, recall = nothing) => needsSession(m, "/tmp", recall);
  ok("a greeting", !(await out("hi")) && !(await out("hey there")) && !(await out("thanks!")));
  ok("a question about the agent itself",
     !(await out("who are you?")) && !(await out("what are you doing right now?")));
  ok("a question about work already running",
     !(await out("what did that task find?")) && !(await out("stop the session")));
  ok("something memory actually answers",
     !(await needsSession("what is the duckdb pin and why", "/tmp",
        knows({ name: "duckdb pin", summary: "pinned at 1.4.4-r.4 for DuckPGQ" }))));
}

console.log("\n  failure modes");
{
  const broken = async () => { throw new Error("graph unreadable"); };
  ok("an unreadable graph hands out rather than answering from nothing",
     await needsSession("what is the population of Lima?", "/tmp", broken));
  ok("an empty message is not work", !(await needsSession("", "/tmp", nothing)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
