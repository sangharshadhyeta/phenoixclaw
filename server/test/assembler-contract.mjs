/**
 * Assembling the context instead of accumulating it.
 *
 * This runs on the request path of every single model call, so its edge cases
 * matter more than its happy path: a payload it mangles is not a worse answer,
 * it is a session that cannot talk to its model at all. Most of what follows is
 * about what it must refuse to touch.
 *
 * The one that would actually break things: a turn is a user message and
 * everything after it, including tool calls and the tool results paired with
 * them. Cut inside one and the provider receives a tool result whose call is
 * missing, which is a hard API error.
 *
 *     npm run test:assembler
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { contextAssembler } = await import(dist("pi/context-assembler.js"));
const { upsertNode } = await import(dist("graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

function mount(sessionId) {
  let handler;
  contextAssembler(sessionId, () => new Date("2026-09-05T12:00:00Z"))({
    on: (e, fn) => { if (e === "before_provider_request") handler = fn; },
    registerTool() {},
  });
  return (payload) => handler({ type: "before_provider_request", payload });
}
const run = mount("sess-x");

const sys = { role: "system", content: "YOU ARE THE AGENT" };
const exchange = (n) => [
  { role: "user", content: `question ${n}` },
  { role: "assistant", content: `answer ${n}` },
];
const build = (n) => ({ model: "m", stream: true, messages: [sys, ...Array.from({ length: n }, (_, i) => exchange(i + 1)).flat()] });

// --- passthrough: anything unrecognised is left alone ----------------------
ok("a short conversation is untouched", (await run(build(3))) === undefined);
ok("a non-object payload is untouched", (await run("nonsense")) === undefined);
ok("a payload with no messages is untouched", (await run({ model: "m" })) === undefined);
ok("an empty message list is untouched", (await run({ messages: [] })) === undefined);
ok("messages that are not messages are untouched",
   (await run({ messages: [1, 2, 3] })) === undefined);
ok("messages missing a role are untouched",
   (await run({ messages: [{ content: "hi" }, { content: "there" }] })) === undefined);

// --- the assembly itself ---------------------------------------------------
{
  const before = build(12);
  const after = await run(before);
  ok("a long conversation is assembled", Boolean(after));
  ok("it is shorter than what went in", after.messages.length < before.messages.length);
  ok("the rest of the payload is preserved", after.model === "m" && after.stream === true);
  ok("the original array is not mutated", before.messages.length === 25);

  ok("the system prompt survives", after.messages[0].content.startsWith("YOU ARE THE AGENT"));
  ok("and carries the pointer into memory", /EARLIER IN THIS CONVERSATION/.test(after.messages[0].content));
  ok("which names the node to search", /conversation:2026-09-05:sess-x/.test(after.messages[0].content));
  ok("and quotes where it began", /question 1/.test(after.messages[0].content));

  const kept = after.messages.slice(1);
  ok("the newest exchange is kept verbatim",
     kept[kept.length - 1].content === "answer 12" && kept[kept.length - 2].content === "question 12");
  ok("the window starts on a user message", kept[0].role === "user");
  ok("no synthetic turn is inserted mid-conversation",
     kept.every((m) => ["user", "assistant", "tool"].includes(m.role)));
}

// --- the one that would break the provider ---------------------------------
{
  // A turn with a tool call and its paired result. Cutting between them would
  // hand the provider an orphaned tool result.
  const withTools = {
    model: "m",
    messages: [
      sys,
      ...Array.from({ length: 9 }, (_, i) => exchange(i + 1)).flat(),
      { role: "user", content: "do the thing" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "assistant", content: "done" },
    ],
  };
  const after = await run(withTools);
  ok("a conversation with tool calls still assembles", Boolean(after));

  const kept = after.messages.slice(1);
  const callIds = kept.filter((m) => m.role === "assistant" && m.tool_calls)
                      .flatMap((m) => m.tool_calls.map((c) => c.id));
  const resultIds = kept.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  ok("every tool result kept has its call", resultIds.every((id) => callIds.includes(id)));
  ok("no tool result is orphaned", resultIds.length === 1 && callIds.length === 1);
  ok("the cut landed on a user boundary", kept[0].role === "user");
}

// --- the pointer uses what harvest actually recorded ------------------------
{
  await upsertNode(
    "conversation:2026-09-05:sess-x",
    "episode",
    "when: 2026-09-05 12:00 | they asked: about Polymarket resolution | you said: it uses UMA",
    0.3,
  );
  const after = await run(build(12));
  ok("the real harvested summary is used", /UMA/.test(after.messages[0].content));
  ok("and is presented as recorded memory", /What you have recorded/.test(after.messages[0].content));
}

// --- a session with no id still works --------------------------------------
{
  const anon = mount(undefined);
  const after = await anon(build(12));
  ok("an anonymous session still assembles", Boolean(after));
  ok("and simply omits the node pointer", !/Search your memory for/.test(after.messages[0].content));
}

// --- a conversation with no system message ---------------------------------
{
  const after = await run({ model: "m", messages: Array.from({ length: 12 }, (_, i) => exchange(i + 1)).flat() });
  ok("a system message is created when there was none", after.messages[0].role === "system");
  ok("and holds the pointer", /EARLIER IN THIS CONVERSATION/.test(after.messages[0].content));
}

// --- clamping one oversized tool result, mechanically, no model call -------
// Ported from Sisyphean's memory/compact.py: a large tool result outside the
// current turn is stubbed rather than carried at full size — the piece the
// exchange-boundary trim above does not cover, since a single 32KB `read`
// looks the same as a short one from that trim's point of view. This is what
// put 18,887 input tokens into one request from a result still sitting in
// the kept window several turns after it was read.
{
  const toolExchange = (n, resultChars) => [
    { role: "user", content: `question ${n}` },
    { role: "assistant", content: `answer ${n}` },
    { role: "tool", content: "x".repeat(resultChars), tool_call_id: `c${n}` },
  ];
  const withBigResult = {
    model: "m",
    messages: [
      sys,
      ...toolExchange(1, 32_000),
      { role: "user", content: "and then?" },
      { role: "assistant", content: "one more thing" },
    ],
  };
  const after = await run(withBigResult);
  ok("a big result outside the current turn is stubbed", Boolean(after));
  const stubbed = after.messages.find((m) => m.role === "tool");
  ok("it says how big it was", /32000 chars/.test(stubbed.content));
  ok("and that it was already used", /already read and acted on/.test(stubbed.content));
  ok("the stub is far smaller than the original", stubbed.content.length < 200);

  const withinCurrentTurn = {
    model: "m",
    messages: [
      sys,
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "working on it" },
      { role: "tool", content: "y".repeat(32_000), tool_call_id: "c-now" },
    ],
  };
  const untouched = await run(withinCurrentTurn);
  ok("but a result inside the CURRENT turn is left whole", untouched === undefined);
}

// --- the hard ceiling: total size wins even when nothing is individually big
// A conversation whose every single message is small can still add up past
// the ceiling. Clamping alone cannot help here — nothing is oversized on its
// own — so this is what enforces the actual number this file is for.
{
  const bigConversation = {
    model: "m",
    messages: [sys, ...Array.from({ length: 40 }, (_, i) => exchange(i + 1)).flat()
      .map((m) => ({ ...m, content: m.content.padEnd(2000, ".") }))],
  };
  const after = await run(bigConversation);
  ok("a conversation too big in total is still cut down", Boolean(after));
  const totalChars = after.messages.reduce((n, m) => n + String(m.content).length, 0);
  ok("the assembled request is under the token ceiling",
     Math.ceil(totalChars / 4) <= 8000);
  ok("the newest exchange survives even so",
     after.messages.some((m) => m.content?.includes?.("question 40")));
}

// --- the ceiling is a floor, not a promise ----------------------------------
// A single current turn that is itself over budget cannot be shrunk without
// breaking the "never cut inside a turn" rule, so it is accepted rather than
// mangled.
{
  const hugeCurrentTurn = {
    model: "m",
    messages: [
      sys,
      { role: "user", content: "z".repeat(40_000) },
      { role: "assistant", content: "working on it" },
    ],
  };
  const result = await run(hugeCurrentTurn);
  ok("an oversized current turn is left whole rather than broken",
     result === undefined || result.messages.some((m) => m.content?.length > 30_000));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
