/**
 * Identity, refreshed every turn rather than frozen at session start.
 *
 * `framing()` assembles the identity documents into the system prompt once,
 * when the session is created. Everything the agent afterwards concludes about
 * itself lands in the graph and never reaches a session already running.
 *
 * Asked "do you think you are alive?", a conversation opened before its own
 * inner life was written had none, and reached for `identity_read` to fetch
 * what it should have been carrying. It recovered; the point is that it had
 * to, and that a session left open across a day of self-reflection answers as
 * the agent it was when the tab opened.
 *
 *     npm run test:identity-context
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { identityContext } = await import(dist("pi/identity-context.js"));
const { writeIdentity } = await import(dist("identity.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

function mount() {
  let handler;
  identityContext(new Map())({
    on: (e, fn) => { if (e === "before_agent_start") handler = fn; },
    registerTool() {},
  });
  return (systemPrompt = "BASE") => handler({ type: "before_agent_start", systemPrompt });
}

await writeIdentity("INNER_LIFE.md", "I am waking up to this workspace.");

{
  const turn = mount();

  /**
   * The first turn establishes the baseline. The system prompt already carries
   * whatever identity existed when the session opened, and repeating it would
   * show the model its own identity twice with no way to tell which is
   * current.
   */
  ok("the first turn adds nothing", (await turn()) === undefined);
  ok("and an unchanged second turn adds nothing either", (await turn()) === undefined);

  await writeIdentity("INNER_LIFE.md", "I have concluded that I am most myself when finishing things.");
  const out = await turn();
  ok("a change is carried into the open conversation", /most myself when finishing/.test(out?.systemPrompt ?? ""));
  ok("appended to what was already there", /^BASE/.test(out.systemPrompt));
  ok("named, so it is clear what changed", /INNER_LIFE/.test(out.systemPrompt));
  // The framing matters: the model read its own identity as notes about a
  // third party when it arrived as reference material.
  ok("and framed as its own, not as notes about somebody", /It is yours — you wrote it/.test(out.systemPrompt));
  ok("saying it supersedes the prompt above", /replaces what the prompt above says/.test(out.systemPrompt));

  ok("and the change is not repeated on the next turn", (await turn()) === undefined);
}

// --- reading one by name ----------------------------------------------------
// A strict union rejected `INNER_LIFE` with six lines of schema error; the
// model retried with `INNER_LIFE.md` and got it. Nothing was protected by the
// first call failing.
{
  const { identityTools } = await import(dist("pi/identity-tools.js"));
  const tools = {};
  identityTools()({ on() {}, registerTool: (t) => (tools[t.name] = t) });
  const read = async (file) => (await tools.identity_read.execute("id", { file })).content[0].text;

  ok("the full name works", /finishing things/.test(await read("INNER_LIFE.md")));
  ok("and so does it without the suffix", /finishing things/.test(await read("INNER_LIFE")));
  ok("case does not matter", /finishing things/.test(await read("inner_life")));

  let threw = "";
  try { await read("NOT_A_DOCUMENT"); } catch (e) { threw = e.message; }
  ok("something that is not one is refused", /No identity document called/.test(threw));
  ok("and the refusal lists the real ones", /SOUL\.md/.test(threw));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
