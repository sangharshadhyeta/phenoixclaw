/**
 * The one call in this portal that keeps thinking on, and only what is
 * mechanical about it: the hint text, and refusing to run with nothing
 * configured to run against. What it actually classifies needs a real model
 * and is exercised live, not here — see the ARCHITECTURE note in
 * pi/route-hint.ts for why this exists at all.
 *
 *     npm run test:route-hint
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { routeHint, routeQuery, ROUTE_LABELS } = await import(dist("pi/route-hint.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

ok("direct gets no hint — the conversation needs none",
   routeHint("direct") === "");
ok("no label gets no hint",
   routeHint("") === "");
for (const label of ROUTE_LABELS) {
  if (label === "direct") continue;
  ok(`"${label}" gets a hint`, routeHint(label).trim().length > 0);
}
ok("bash names computation", /computation/.test(routeHint("bash")));
ok("search names a live lookup", /lookup/.test(routeHint("search")));
ok("memory names saving or recall", /save|recall/.test(routeHint("memory")));
ok("code names a file", /file/.test(routeHint("code")));

// --- no server configured is the same "" every other failure returns -------
{
  const saved = process.env.LLAMA_BASE_URL;
  delete process.env.LLAMA_BASE_URL;
  // route-hint.ts reads the env once at module load, so this only proves the
  // fast path exists when nothing is configured at all — the module under
  // test here was already loaded with whatever the test runner's env had.
  // Real behaviour against a configured server is verified live.
  if (!saved) {
    ok("an empty query short-circuits to no label", (await routeQuery("")) === "");
    ok("and whitespace does too", (await routeQuery("   ")) === "");
  } else {
    ok("an empty query short-circuits to no label regardless of configuration",
       (await routeQuery("")) === "");
    process.env.LLAMA_BASE_URL = saved;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
