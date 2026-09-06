/**
 * The graph's curation layer: decay, deduplication, provenance and recency.
 *
 * All four exist to answer one question — "how many times will you be able to
 * correct the graph?" — with none. A graph where confidence only ever rises,
 * near-duplicates never merge, nothing records where it came from and old beats
 * new needs a person weeding it, and that does not scale past the first few
 * mistakes.
 *
 *     npm run test:curation
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const g = await import(dist("graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const age = async (name, days) => {
  const conn = await g.getDbForTest?.();
  return conn;
};

// --- decay: an unrepeated belief loses standing --------------------------
{
  await g.upsertNode("the api rate limit is 100/min", "fact", "Rate limit is 100 per minute.", 0.8);
  await g.upsertNode("recently confirmed thing", "fact", "Confirmed yesterday.", 0.8);
  await g.upsertNode("identity:test", "anchor", "Who the agent is.", 1.0);
  await g.upsertNode("about the person", "user", "They dislike morning meetings.", 0.9);

  // Age the first one past the decay window, leaving the others fresh.
  const conn = await g.__conn();
  await conn.run("UPDATE nodes SET last_seen = now() - INTERVAL 60 DAY WHERE id = 'the api rate limit is 100/min'");
  await conn.run("UPDATE nodes SET last_seen = now() - INTERVAL 60 DAY WHERE id = 'identity:test'");
  await conn.run("UPDATE nodes SET last_seen = now() - INTERVAL 60 DAY WHERE id = 'about the person'");

  const before = (await g.getNode("the api rate limit is 100/min")).confidence;
  const decayed = await g.decayStaleBeliefs(30);
  const after = (await g.getNode("the api rate limit is 100/min")).confidence;

  ok("a stale belief loses confidence", after < before);
  ok("and is reported as decayed", decayed >= 1);
  ok("but is demoted, not deleted", after > 0);
  ok("a fresh belief is untouched",
     (await g.getNode("recently confirmed thing")).confidence === 0.8);
  ok("identity never decays", (await g.getNode("identity:test")).confidence === 1);
  ok("nor does what the person told you", (await g.getNode("about the person")).confidence === 0.9);

  // Repeated decay must not erase — a floor, not a slide to zero.
  for (let i = 0; i < 40; i++) await g.decayStaleBeliefs(30);
  const floored = (await g.getNode("the api rate limit is 100/min")).confidence;
  ok("decay floors rather than erasing", floored >= 0.1);
  ok("and the belief is still findable", Boolean(await g.getNode("the api rate limit is 100/min")));
}

// --- provenance: every write says where it came from ---------------------
{
  await g.upsertNode("told by the user", "fact", "Something they said.", 0.5, { source: "primary-user" });
  const node = await g.getNode("told by the user");
  ok("a source is recorded", Array.isArray(node.sources) && node.sources.includes("primary-user"));

  // A second source corroborating is worth more than the same one twice.
  await g.upsertNode("told by the user", "fact", "Something they said.", 0.5, { source: "https://example.com/page" });
  const both = await g.getNode("told by the user");
  ok("sources are unioned, not replaced", both.sources.length === 2);
  ok("and keep the original", both.sources.includes("primary-user"));

  await g.upsertNode("told by the user", "fact", "Something they said.", 0.5, { source: "primary-user" });
  ok("the same source twice is not counted twice",
     (await g.getNode("told by the user")).sources.length === 2);
}

// --- recency: fresher wins between beliefs of equal strength -------------
{
  await g.upsertNode("deploy target alpha", "fact", "The deploy target is alpha cluster.", 0.7);
  await g.upsertNode("deploy target beta", "fact", "The deploy target is beta cluster.", 0.7);
  const conn = await g.__conn();
  await conn.run("UPDATE nodes SET last_seen = now() - INTERVAL 200 DAY WHERE id = 'deploy target alpha'");

  const hits = await g.personalRecall("deploy target cluster", "/workspaces/x", 5);
  const names = hits.map((h) => h.name);
  ok("both are still found", names.includes("deploy target alpha") && names.includes("deploy target beta"));
  ok("and the fresher one ranks first",
     names.indexOf("deploy target beta") < names.indexOf("deploy target alpha"));
}

// --- deduplication: "Gemma model" and "the Gemma model" are one thing -----
// Needs embeddings: matching labels by string overlap would fuse "Qdrant
// client" and "Qdrant server", which are close as text and different subjects.
// Skipped loudly rather than silently passing when no embedder is reachable.
{
  const embedder = process.env.EMBEDDING_BASE_URL;
  let reachable = false;
  if (embedder) {
    try {
      const res = await fetch(embedder, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "probe" }),
        signal: AbortSignal.timeout(5000),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
  }

  if (!reachable) {
    console.log("  SKIP  semantic dedup — no embedding server (set EMBEDDING_BASE_URL to cover it)");
  } else {
    await g.upsertNode("Gemma model", "concept", "A local language model.", 0.5);
    const before = (await g.nodesByType("concept", 500)).length;

    await g.upsertNode("the Gemma model", "concept", "A local language model we run.", 0.5);
    const after = (await g.nodesByType("concept", 500)).length;
    ok("a near-duplicate label does not create a second node", after === before);
    ok("and corroborates the original instead",
       (await g.getNode("Gemma model")).observations >= 2);

    await g.upsertNode("Qdrant server", "concept", "A vector database server.", 0.5);
    const n1 = (await g.nodesByType("concept", 500)).length;
    await g.upsertNode("Postgres replication", "concept", "How Postgres replicates.", 0.5);
    ok("an unrelated subject is still its own node",
       (await g.nodesByType("concept", 500)).length === n1 + 1);
  }
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
