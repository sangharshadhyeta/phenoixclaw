/**
 * The transcript's grouping — what makes one stream readable.
 *
 * The main conversation now carries work from every session at once. Flat, that
 * is an interleave: three sessions working together produce lines that alternate
 * between them, and following any single thread means reading past the other
 * two. Grouping restores the thread without giving up the one-stream view.
 *
 *     npm run test:transcript
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Compiled with the real TypeScript compiler rather than a regex strip: the
// transcript is the thing under test, and a hand-rolled transpile that silently
// mangles it would test something else.
const { execFileSync } = await import("node:child_process");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

const out = mkdtempSync(path.join(tmpdir(), "transcript-"));
execFileSync(
  "npx",
  ["tsc", path.join(here, "..", "..", "web", "src", "transcript.ts"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
   "--skipLibCheck"],
  { cwd: path.join(here, "..", ".."), stdio: "pipe" },
);
const mod = await import(path.join(out, "transcript.js"));
const build = mod.buildTranscript;

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const mirrored = (seq, source, type, payload) => ({
  seq, type: "mirrored", payload: { source, type, payload },
});
const prompt = (seq, message) => ({ seq, type: "portal_prompt", payload: { message } });

// --- consecutive lines from one session become one thread ------------------
{
  const items = build([
    mirrored(1, "build-the-thing", "portal_prompt", { message: "Fix the failing test" }),
    mirrored(2, "build-the-thing", "tool_execution_start", { toolName: "read", args: { command: "a.ts" } }),
    mirrored(3, "build-the-thing", "tool_execution_start", { toolName: "edit", args: { command: "a.ts" } }),
    mirrored(4, "build-the-thing", "message_end", { text: "Fixed it." }),
  ]);
  ok("they fold into one thread", items.length === 1 && items[0].kind === "thread");
  ok("which keeps every line", items[0].items.length === 4);
  ok("and is labelled with the session", items[0].source === "build-the-thing");
}

// --- a different session starts a new thread -------------------------------
{
  const items = build([
    mirrored(1, "alpha", "tool_execution_start", { toolName: "read", args: {} }),
    mirrored(2, "alpha", "tool_execution_start", { toolName: "grep", args: {} }),
    mirrored(3, "beta", "tool_execution_start", { toolName: "ls", args: {} }),
    mirrored(4, "beta", "tool_execution_start", { toolName: "read", args: {} }),
  ]);
  ok("two sessions make two threads", items.length === 2);
  ok("in the order they happened", items[0].source === "alpha" && items[1].source === "beta");
}

// --- something you said interrupts the run ---------------------------------
{
  const items = build([
    mirrored(1, "alpha", "tool_execution_start", { toolName: "read", args: {} }),
    mirrored(2, "alpha", "tool_execution_start", { toolName: "grep", args: {} }),
    prompt(3, "stop, do this instead"),
    mirrored(4, "alpha", "tool_execution_start", { toolName: "ls", args: {} }),
    mirrored(5, "alpha", "tool_execution_start", { toolName: "read", args: {} }),
  ]);
  ok("your message is not swallowed into a thread",
     items.some((i) => i.kind === "user" && i.text === "stop, do this instead"));
  ok("and the run either side is two threads, not one",
     items.filter((i) => i.kind === "thread").length === 2);
  ok("ordering is preserved", items[1].kind === "user");
}

// --- a lone line is not worth a collapsible header --------------------------
{
  const items = build([mirrored(1, "alpha", "tool_execution_start", { toolName: "read", args: {} })]);
  ok("one line stays a plain line", items.length === 1 && items[0].kind === "self");
}

// --- what the session was asked to do survives, since it explains the rest --
{
  const items = build([
    mirrored(1, "alpha", "portal_prompt", { message: "Summarise the changelog" }),
    mirrored(2, "alpha", "tool_execution_start", { toolName: "read", args: {} }),
  ]);
  const asked = items[0].items.find((i) => i.mode === "asked");
  ok("the request is kept and marked", asked && asked.text === "Summarise the changelog");
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
