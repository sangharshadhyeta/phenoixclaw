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

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
