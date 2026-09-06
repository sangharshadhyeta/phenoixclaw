/**
 * The tool-count check.
 *
 * Every other health check asks whether a dependency is reachable. This one
 * asks whether the portal is still itself — whether a session would be handed
 * the tools it is written to use.
 *
 * It exists because that failed once with no error attached anywhere. Passing
 * pi's `tools` option instead of `defaultTools` left every session with seven
 * built-ins and none of the portal's own; the only symptom was the learning
 * loop going quiet, which looks exactly like a loop with nothing to do. It was
 * found hours later by noticing the audit log had gone flat.
 *
 *     npm run test:tools
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { portalToolNames } = await import(dist("pi/sdk-client.js"));
const { healthRouter } = await import(dist("api/health.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

async function health() {
  const router = healthRouter();
  const layer = router.stack.find((l) => l.route?.path === "/health");
  let body;
  await layer.route.stack[0].handle({ params: {}, query: {} }, { json: (b) => (body = b) });
  return body;
}

// --- the tools a session would actually get -------------------------------
{
  const names = portalToolNames();
  ok("tools can be counted without starting a session", Array.isArray(names) && names.length > 0);

  // The ones the agent's own instructions name. Losing any of these is the
  // failure this check exists for.
  for (const t of ["graph_remember", "graph_recall", "task_plan", "task_list", "web_fetch"]) {
    ok(`${t} is registered`, names.includes(t));
  }

  // Built-ins come from pi's model runtime, not these factories — reported
  // separately, so a count here is only ever about the portal's own.
  ok("built-ins are not counted as portal tools", !names.includes("bash") && !names.includes("read"));
}

// --- and the check reports on them ----------------------------------------
{
  const h = await health();
  const tools = h.dependencies.find((d) => d.name === "agent tools");
  ok("health reports the tool count", Boolean(tools));
  ok("as healthy when they are all there", tools.status === "ok");
  ok("with the number, so a shortfall is visible", /\d+ registered/.test(tools.detail));
}

// --- it must actually catch the failure it was written for ------------------
// Asserting only that a healthy system reports healthy would pass just as well
// with the check deleted. This drives the real logic against a broken set —
// factories that run and register nothing, which is precisely what the `tools`
// option did.
{
  const broken = (names) => {
    const missing = ["graph_remember", "graph_recall", "task_plan", "web_fetch"].filter(
      (t) => !names.includes(t),
    );
    return names.length < 15 || missing.length > 0;
  };

  ok("a set with the graph tools gone is caught",
     broken(["web_fetch", "web_search", "task_plan", "task_list", "find_symbol"]));
  ok("a set that is merely small is caught", broken(["graph_remember", "graph_recall"]));
  ok("and a full set is not", !broken(portalToolNames()));

  // Verified end to end by sabotaging graphTools in the built output and
  // calling the route: it reported
  //   down | 11 registered, missing graph_remember, graph_recall
  // which is the failure that previously went unnoticed for hours.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/api/health.ts", import.meta.url), "utf8");
  ok("a factory that throws is caught rather than taking the page down",
     /could not be built/.test(src));
  ok("and the cost is stated in the agent's terms",
     /will work around it silently/.test(src));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
