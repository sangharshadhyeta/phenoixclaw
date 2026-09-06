/**
 * One conversation, nothing hidden — and nothing buried.
 *
 * The mirror puts work from other sessions into the agent's main conversation
 * so a person has one place that says what it is doing. Its own header names
 * the failure it has to avoid: "mirroring every token would bury a conversation
 * under an inner monologue that never stops, which is hiding by volume."
 *
 * That is not a hypothetical. Extending the mirror to task sessions immediately
 * put every file the agent read back into the main conversation, because pi
 * emits `message_end` for `toolResult` messages too — the bulk arrived under a
 * different name than the one that had been excluded.
 *
 *     npm run test:mirror
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { isMirrorable } = await import(dist("mirror.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- what may reach the main conversation at all ---------------------------
ok("a request is mirrored", isMirrorable("portal_prompt") === true);
ok("what the agent said is mirrored", isMirrorable("message_end") === true);
ok("which tool it reached for is mirrored", isMirrorable("tool_execution_start") === true);
ok("a routine's bookends are mirrored", isMirrorable("portal_routine") === true);

ok("a tool's OUTPUT is not", isMirrorable("tool_execution_end") === false);
ok("nor are streaming deltas", isMirrorable("message_update") === false);
ok("nor status changes", isMirrorable("portal_status") === false);

// --- the trimming, which is what keeps it readable -------------------------
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/mirror.ts", import.meta.url), "utf8");

  ok("only the assistant's own messages are carried",
     /message\?\.role !== "assistant"/.test(src));
  ok("content is read as an array of parts, not a string",
     /Array\.isArray\(content\)/.test(src));
  ok("and an empty result is dropped rather than stored",
     /if \(trimmed === undefined\) return undefined/.test(src));
  ok("tool arguments keep their shape for the web transcript",
     /args: typeof first === "string"/.test(src));
  ok("prompts are clipped", /clip\(p\.message, MIRRORED_TEXT\)/.test(src));
}

// --- which sessions appear, and which must not -----------------------------
{
  const { readFileSync } = await import("node:fs");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  const fn = sm.slice(sm.indexOf("private mirrorLabel"), sm.indexOf("private async mirrorToMain"));

  ok("routines appear", /kind === "routine"/.test(fn));
  ok("task sessions appear", /kind === "task"/.test(fn));
  // An agent session IS a conversation with somebody. Folding one person's
  // chat into another's is not a display decision, it is a disclosure.
  ok("channel conversations do not", /return undefined;\s*\}$/m.test(fn.trim()));
  ok("and the reason is written down", /disclosure/.test(sm));
}

/**
 * A task's answer reaches the conversation once.
 *
 * `portal_task_result` carries the whole thing, exempt from the clip every
 * other mirrored line gets — it is not a notice that something happened, it is
 * what was asked for. Reported by a live run: the answer appeared twice, once
 * as the reply the task gave and again underneath as "finished", verbatim.
 */
{
  ok("a finished task's answer is mirrorable", isMirrorable("portal_task_result"));
  ok("and a tool result still is not", !isMirrorable("tool_execution_end"));

  const src = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  // record() writes into the session *and* mirrors, which put the answer in
  // the task's own transcript underneath the reply it had just given.
  ok("the result is not recorded back into the session that produced it",
     /await this\.mirrorToMain\(sessionId, "portal_task_result"/.test(src));
  ok("and a task's prose does not follow it to the conversation",
     /type === "message_end" && this\.kindOf\.get\(sessionId\) === "task"/.test(src));

  const mirrorSrc = readFileSync(new URL("../src/mirror.ts", import.meta.url), "utf8");
  ok("the answer itself is exempt from the clip",
     /if \(type === "portal_task_result"\) return p;/.test(mirrorSrc));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
