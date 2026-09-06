/**
 * What the deployment can do, and what it has cost.
 *
 * Every dependency degrades silently by design, which is right for a request in
 * flight and wrong for a deployment: conversation harvesting ran for a full day
 * extracting nothing because LLAMA_BASE_URL was unset, and the feature looked
 * like it worked. The boot log helps whoever was watching the console at the
 * time; this answers the same question afterwards.
 *
 *     npm run test:health
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { healthRouter } = await import(dist("api/health.js"));
const { addUsage, totalUsage, createSession } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

/** Drive the route without standing up Express. */
async function health() {
  const router = healthRouter();
  const layer = router.stack.find((l) => l.route?.path === "/health");
  let body;
  await layer.route.stack[0].handle({ params: {}, query: {} }, { json: (b) => (body = b) });
  return body;
}

// --- the shape an operator reads ------------------------------------------
{
  const h = await health();
  ok("an overall verdict is given", ["ok", "degraded", "down"].includes(h.status));
  ok("every dependency is listed", h.dependencies.length >= 5);
  ok("uptime is reported", typeof h.uptimeSeconds === "number");

  const names = h.dependencies.map((d) => d.name);
  for (const n of ["portal database", "knowledge graph", "extraction", "embeddings", "web search"]) {
    ok(`${n} is covered`, names.includes(n));
  }
}

// --- unconfigured is not broken -------------------------------------------
{
  // SEARXNG_URL is unset in this environment, which is a choice rather than a
  // fault. Reporting it as a failure teaches people to ignore the page, and a
  // health page exists to be believed.
  const h = await health();
  const search = h.dependencies.find((d) => d.name === "web search");
  ok("an unconfigured dependency reads as off, not down", search.status === "off");
  ok("and says what it costs", /web_search is unavailable/.test(search.costs ?? ""));
  ok("off alone does not make the portal unhealthy",
     h.status !== "down" || h.dependencies.some((d) => d.status === "down"));
}

// --- storage is always checked, since nothing works without it -------------
{
  const h = await health();
  const db = h.dependencies.find((d) => d.name === "portal database");
  ok("the database is probed, not assumed", db.status === "ok" && /session/.test(db.detail));
  const graph = h.dependencies.find((d) => d.name === "knowledge graph");
  ok("and so is the graph", graph.status === "ok" && /node/.test(graph.detail));
}

// --- usage accumulates rather than being read live -------------------------
{
  await createSession({ id: "usage-a", title: "a", workspace: "/w", executor: "host" });
  await addUsage("usage-a", { tokensIn: 100, tokensOut: 20, cost: 0.5 });
  await addUsage("usage-a", { tokensIn: 50, tokensOut: 10, cost: 0.25 });

  const total = await totalUsage();
  ok("two turns add up", total.tokensIn === 150 && total.tokensOut === 30);
  ok("and so does cost", Math.abs(total.cost - 0.75) < 1e-9);

  // A recycled conversation restarts pi's counters; the row must not restart.
  await addUsage("usage-a", { tokensIn: 5, tokensOut: 1, cost: 0 });
  ok("a fresh conversation adds to the total rather than replacing it",
     (await totalUsage()).tokensIn === 155);

  await addUsage("usage-a", { tokensIn: 0, tokensOut: 0, cost: 0 });
  ok("an empty turn is a no-op", (await totalUsage()).tokensIn === 155);

  const h = await health();
  ok("the total is reported alongside health", h.usage.tokensIn === 155);
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
