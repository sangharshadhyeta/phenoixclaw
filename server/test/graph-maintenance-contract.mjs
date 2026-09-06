/**
 * Making the graph navigable, not merely full.
 *
 * Decay is about what is *true*. These two passes are about what is
 * *reachable*: extraction writes a node per fact, so a run of searches on one
 * subject leaves a handful connected to nothing — findable by name and
 * unreachable from anything else the agent knows — and it writes `related_to`
 * whenever it sees two things together and cannot say how, which records that
 * both exist and nothing more.
 *
 * Both run unattended, so what matters most is that they cannot damage the
 * graph they are tidying.
 *
 *     npm run test:graph-maintenance
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const g = await import(path.join(here, "..", "dist", "graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- naming a topic ---------------------------------------------------------
{
  ok("a shared subject names the topic",
     JSON.stringify(g.topicWords(["Rust ownership rules", "Rust borrow checker", "Rust lifetimes"])) === '["rust"]');
  // Nodes written in the same minute about nothing in common are a coincidence
  // of scheduling, not a topic.
  ok("unrelated names share no topic",
     g.topicWords(["DuckDB checkpoints", "Rust lifetimes", "quarterly revenue"]).length === 0);
  ok("filler words never become a topic",
     g.topicWords(["the meaning of it", "the meaning of that", "the meaning of this"]).length === 0);
  ok("one name is not a cluster", g.topicWords(["Rust lifetimes"]).length === 0);
  ok("and nothing at all is safe", g.topicWords([]).length === 0);
}

// --- the label that replaces a placeholder ----------------------------------
// Accepted only if it says what one thing does to the other. The alternative
// to a bad label is the placeholder, which is not worse.
{
  ok("a verb phrase is kept", g.usableRelation("is a kind of") === "is_a_kind_of");
  ok("a single verb is kept", g.usableRelation("contradicts") === "contradicts");
  ok("the model saying it cannot tell is honoured", g.usableRelation("unknown") === undefined);
  ok("the placeholder is not accepted as its own replacement", g.usableRelation("related to") === undefined);
  ok("a bare noun is refused", g.usableRelation("thing") === undefined);
  ok("an essay is refused", g.usableRelation("a very long phrase that goes on and on") === undefined);
  ok("markup is refused", g.usableRelation("<script>") === undefined);
  ok("nothing is refused", g.usableRelation(undefined) === undefined);
  ok("quotes and full stops are trimmed", g.usableRelation('"depends on".') === "depends_on");
}

// --- the passes, against a real graph ---------------------------------------
{
  for (const [name, summary] of [
    ["duckdb art index", "The ART index does not tidy itself after a delete."],
    ["duckdb checkpoint behaviour", "A checkpoint rewrites block metadata."],
    ["duckdb wal replay", "The WAL is replayed on open."],
  ]) {
    await g.upsertNode(name, "fact", summary, 0.8);
  }

  const before = await g.clusterIsolatedNodes(15, 3);
  ok("unconnected nodes on one subject are gathered", before.clusters >= 1 && before.linked >= 3);

  // The topic node has to be reachable from its members, or the pass has done
  // nothing that traversal can follow.
  const members = await g.neighbors("duckdb art index");
  ok("and each member now points at the topic",
     Array.isArray(members) && members.some((m) => /duckdb/.test(String(m?.name ?? m))));

  // Running twice must not pile up duplicate edges or topics.
  const again = await g.clusterIsolatedNodes(15, 3);
  ok("running it again finds nothing new to link", again.linked === 0 || again.clusters === 0);
}

{
  await g.upsertNode("the lexer", "concept", "Turns source text into tokens.", 0.9);
  await g.upsertNode("the token type", "concept", "The record a lexer produces.", 0.9);
  await g.upsertEdge("the lexer", "related_to", "the token type");

  // A model that will not answer, or answers uselessly, must leave the edge
  // exactly as it was.
  ok("a model that says nothing refines nothing", (await g.refineRelations(10, async () => undefined)) === 0);
  ok("an unusable answer refines nothing", (await g.refineRelations(10, async () => "thing")) === 0);
  ok("and 'unknown' is respected", (await g.refineRelations(10, async () => "unknown")) === 0);

  const refined = await g.refineRelations(10, async () => "produces");
  ok("a good answer replaces the placeholder", refined >= 1);
  ok("and there is nothing left to refine", (await g.refineRelations(10, async () => "produces")) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
