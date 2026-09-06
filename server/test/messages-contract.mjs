/**
 * The agent, reachable as a model.
 *
 * Sisyphean exposed an Anthropic Messages endpoint so any harness pointed at
 * it inherited the memory graph, the injector and the guard without knowing
 * they existed. The audit dismissed it because "statelessness is what
 * Phoenixclaw inverts" — which answers a different question: the base64 state
 * smuggled through thinking blocks was scaffolding forced by having nowhere to
 * put state, and is not the idea.
 *
 * Two things matter here and both are about honesty at the boundary: it must
 * not accept the portal's browser cookie, and it must not pretend to stream.
 *
 *     npm run test:messages
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { lastUserText } = await import(path.join(here, "..", "dist", "api", "messages.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- reading the request ----------------------------------------------------
// A Messages request carries the whole conversation because the server is
// assumed to have no memory of it. This one does, so only the last user turn
// is the prompt.
{
  ok("a plain string message", lastUserText([{ role: "user", content: "hello" }]) === "hello");
  ok("content blocks are joined",
     lastUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]) === "a\nb");

  const conversation = [
    { role: "user", content: "first thing" },
    { role: "assistant", content: "an answer" },
    { role: "user", content: "the actual question" },
  ];
  ok("the last user turn wins", lastUserText(conversation) === "the actual question");
  ok("and the assistant's turns are not mistaken for it", !lastUserText(conversation).includes("an answer"));

  // Non-text blocks (images, tool results) must not produce an empty prompt
  // that reads as a valid one.
  ok("a message of only images yields nothing",
     lastUserText([{ role: "user", content: [{ type: "image", source: {} }] }]) === "");
  ok("but text alongside them is found",
     lastUserText([{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "what is this" }] }]) === "what is this");
  ok("an empty conversation yields nothing", lastUserText([]) === "");
  ok("a malformed body yields nothing rather than throwing", lastUserText(undefined) === "");
  ok("assistant-only yields nothing", lastUserText([{ role: "assistant", content: "hi" }]) === "");
}

// --- the boundary, as source ------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/api/messages.ts", import.meta.url), "utf8");

  // A browser that has logged into the portal must not become a way for any
  // page it visits to drive the agent.
  ok("it authenticates with x-api-key", /x-api-key/.test(src));
  ok("and not with the portal cookie", !/req\.cookies/.test(src));

  // A single non-streamed chunk dressed as a stream satisfies the schema and
  // lies about the thing the caller asked for.
  ok("streaming is refused rather than faked", /Streaming is not implemented/.test(src));
  ok("and it points at the stream that does exist", /sessions\/:id\/events/.test(src));

  // The caller's transcript is dropped. That is a real difference in
  // behaviour, so it is stated in the response rather than left to be found.
  ok("the response says the history was ignored", /history: "ignored/.test(src));
  ok("and which session answered", /session_id: sessionId/.test(src));

  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  ok("it is mounted before the cookie gate",
     idx.indexOf("messagesRouter()") < idx.indexOf('app.use("/api", requireAuth)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
