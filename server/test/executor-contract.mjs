/**
 * Which session kinds each executor may run.
 *
 * `container` registers no guard: rpc-client.ts has no reference to
 * guardExtension, roles, taint or the constitution, and ContainerExecutor reads
 * only sessionId and workspacePath from its LaunchOptions — role, whoNow,
 * enforceTaint, autonomous, tainted and projectTrusted are all discarded.
 *
 * That is fine for a task session, where the container is the boundary and
 * there is no speaker to check. It is not fine for a channel conversation,
 * where the role check is the only thing between a stranger and the machine,
 * nor for an autonomous routine, where the constitution's allowlist is the only
 * bound on a turn nobody asked for.
 *
 *     npm run test:executor
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { executorSupports, unsupportedReason } = await import(dist("executors/index.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- host runs everything: it is where the guard actually lives -------------
for (const kind of ["task", "agent", "routine"]) {
  ok(`host runs a ${kind} session`, executorSupports("host", kind) === true);
}

// --- container runs only what does not need the guard -----------------------
ok("container runs a task session", executorSupports("container", "task") === true);
ok("container refuses a channel conversation", executorSupports("container", "agent") === false);
ok("container refuses a routine", executorSupports("container", "routine") === false);

// --- and the refusal has to be actionable ----------------------------------
{
  const agent = unsupportedReason("agent");
  ok("the channel refusal names the missing control", /roles|people/i.test(agent));
  ok("says what the exposure is", /same access as you|colleague|stranger/i.test(agent));
  ok("and names the way out", /EXECUTOR=host/.test(agent));

  const routine = unsupportedReason("routine");
  ok("the routine refusal names the constitution", /constitution/i.test(routine));
  ok("says what the exposure is", /unbounded/i.test(routine));
  ok("and names the way out", /EXECUTOR=host/.test(routine));
}

// --- the wiring itself, so a refusal cannot be forgotten at the call site ---
{
  const { readFileSync } = await import("node:fs");
  const sm = readFileSync(new URL("../src/session-manager.ts", import.meta.url), "utf8");
  ok("the session manager checks before launching", /executorSupports\(EXECUTOR_KIND, session\.kind\)/.test(sm));
  ok("and records the refusal on the session rather than failing silently",
     /status: "error", last_error: why/.test(sm));

  const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  ok("and the limitation is announced at boot", /registers no guard, so it runs task sessions only/.test(idx));
}

// --- restricting an autonomous turn must not disarm it ---------------------
// pi's `tools` option is the WHOLE allowlist, extensions included: passing the
// read set there stripped every tool the portal registers, and the learning
// loop reported that it could only use read/grep/find/ls and stopped. A
// denylist over the built-ins is what was meant.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/pi/sdk-client.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  ok("the built-in set is not narrowed by autonomy",
     /const BUILTIN_TOOLS = \[\.\.\.READ_TOOLS, "bash", "edit", "write"\]/.test(code));
  // `tools` is the WHOLE allowlist and takes the portal's own tools with it;
  // `defaultTools` picks the built-in selection and leaves extensions alone.
  ok("built-ins are chosen via defaultTools, not an allowlist",
     /settings\.defaultTools =/.test(code) && !/^\s*tools,$/m.test(code));
  ok("an autonomous turn is restricted by denylist instead",
     /opts\.autonomous\s*\?\s*\["bash", "edit", "write"\]/.test(code));
  // A conversation starts sessions, answers from memory, and relays what came
  // back. Holding a planner's tools is what had it answering "hi" with a
  // task_start call.
  ok("a conversation gets none of the built-ins",
     /const conversational = opts\.kind === "agent"/.test(code) &&
     /conversational\s*\?\s*\[\.\.\.BUILTIN_TOOLS\]/.test(code));
  ok("nor the planning and writing tools",
     /if \(opts\.sessionId && !conversational\)/.test(code));
  ok("nor a way to reach the world itself",
     /conversational \? \[\] : \[\{ name: "web"/.test(code));
  ok("and it is actually passed to the session", /excludeTools \? \{ excludeTools \}/.test(code));
  ok("grep, find and ls are registered so the role allowlist means something",
     /READ_TOOLS = \["read", "grep", "find", "ls"\]/.test(code));
}

// --- a container task has no network unless somebody asks --------------------
// The portal restricts no egress at all, which is a deliberate property of the
// host executor. `container` exists for the case you are less sure about, and
// dropping capabilities, memory and PIDs while leaving the network on isolated
// everything except the path that carries data out.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/executors/index.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  ok("the container is launched with a network flag", /"--network",/.test(code));
  ok("and it defaults to none", /CONTAINER_NETWORK\?\.trim\(\) \|\| "none"/.test(code));
  ok("with an escape for a task that needs one", /CONTAINER_NETWORK/.test(src));
  ok("alongside the isolation that was already there",
     /--cap-drop/.test(code) && /no-new-privileges/.test(src) && /--pids-limit/.test(code));
}

// --- everything the session manager builds must actually be forwarded ------
// `startTask` was built, spread into `launch()`, and silently dropped: it was
// not declared on `LaunchOptions`, and an undeclared property is not an error,
// it is just gone. The chat therefore never had `start_task` — while three
// separate mechanisms were added to make it call the tool, and the model
// eventually said so itself: "I don't see a start_task tool in the list."
{
  const { readFileSync } = await import("node:fs");
  const ex = readFileSync(new URL("../src/executors/index.ts", import.meta.url), "utf8");
  ok("startTask is declared on LaunchOptions", /startTask\?: \(pi: any\) => void;/.test(ex));
  ok("and actually forwarded to the client", /startTask: opts\.startTask,/.test(ex));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
