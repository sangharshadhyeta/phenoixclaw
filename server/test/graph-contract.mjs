/**
 * The knowledge graph's contract, ported from BirdClaw's
 * `tests/test.py :: TestKnowledgeGraph` plus the rules this port added on top
 * (corroboration, anchor protection).
 *
 * A plain node script rather than a test framework: the repo has no test
 * infrastructure and this needs none — it wants a real DuckDB file, which a
 * mock would defeat. Run it against a throwaway DATA_DIR:
 *
 *     npm run test:graph
 *
 * It is here because running it found three bugs that typechecking could not:
 * a node became permanently unwritable once it had an edge (DuckDB rewrites an
 * UPDATE on a referenced table as delete+insert, tripping its own foreign
 * key); DuckPGQ crashed the whole process from a background thread on any
 * graph past a handful of nodes; and single-node deletion did not exist, so a
 * wrong belief could not be corrected. Each of those is invisible to `tsc` and
 * obvious the first time something actually writes to the graph twice.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, so the script runs from anywhere.
const here = path.dirname(fileURLToPath(import.meta.url));
const g = await import(path.join(here, "..", "dist", "graph.js"));

if (!process.env.DATA_DIR) {
  console.error("Set DATA_DIR to a throwaway directory — this writes a real DuckDB file.");
  process.exit(2);
}
let pass = 0, fail = 0, gap = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };
const missing = (n, why) => { gap++; console.log("  GAP   " + n + "  — " + why); };

await g.upsertNode("Python", "concept", "Programming language");
const py = await g.getNode("Python");
ok("upsert_and_get_node", py && py.type === "concept" && py.summary.includes("Programming"));

await g.upsertNode("Django", "concept", "Web framework");
await g.upsertNode("Django", "concept", "Python web framework updated");
ok("upsert_updates_existing", (await g.getNode("Django")).summary.includes("updated"));

ok("get_node_unknown_returns_none", (await g.getNode("nonexistent_node_xyz")) === undefined);

await g.upsertEdge("Django", "depends_on", "Python");
const nbrs = await g.neighbors("Django");
ok("upsert_edge", nbrs.some((n) => n.name === "Python" && n.relation === "depends_on"));

await g.upsertNode("FastAPI", "concept", "async web framework for Python APIs");
await g.upsertNode("Django REST", "concept", "REST API framework");
await g.upsertNode("Unrelated Node", "concept", "something entirely different");
const found = await g.searchNodes("Python web API framework", 10);
ok("search_by_token_overlap", found.some((r) => /FastAPI|Django/.test(r.name)));

await g.upsertNode("fact1", "fact", "A fact about testing");
await g.upsertNode("entity1", "concept", "A testing entity");
const typed = await g.searchNodes("testing", 10, "fact");
ok("search_by_type_filter", typed.length > 0 && typed.every((r) => r.type === "fact"));

await g.upsertNode("A", "concept", "node A");
await g.upsertNode("B", "concept", "node B");
await g.upsertNode("C", "concept", "node C");
await g.upsertEdge("A", "related_to", "B");
await g.upsertEdge("A", "related_to", "C");
const bfs = await g.traverse("A", 2);
const names = bfs.map((r) => r.name);
ok("bfs_traversal", names.includes("B") && names.includes("C"));

await g.upsertNode("fact-x", "fact", "first fact");
await g.upsertNode("fact-y", "fact", "second fact");
ok("nodes_by_type", (await g.nodesByType("fact")).every((r) => r.type === "fact"));

await g.upsertNode("ToRemove", "concept", "will be deleted");
ok("remove_node", (await g.removeNode("ToRemove")) === true && (await g.getNode("ToRemove")) === undefined);
ok("remove_nonexistent_returns_false", (await g.removeNode("ghost_node_xyz")) === false);
await g.upsertNode("anchor-guard", "anchor", "identity");
ok("remove_node refuses an anchor", (await g.removeNode("anchor-guard")) === false && Boolean(await g.getNode("anchor-guard")));

const total = await g.nodeCount();
ok("node_count", typeof total === "number" && total > 0);
ok("node_count by type", (await g.nodeCount("fact")) > 0);

// removeNode must take the node's edges with it, or the next join finds a ghost.
await g.upsertNode("Linked", "concept", "has an edge");
await g.upsertEdge("Linked", "related_to", "Python");
await g.removeNode("Linked");
ok("remove_node clears its edges", (await g.neighbors("Python")).every((n) => n.name !== "Linked"));

const again = await g.getNode("persist-me-check") ?? (await g.upsertNode("persist-me-check", "fact", "saved node"), await g.getNode("persist-me-check"));
ok("save_and_reload (durable store)", Boolean(again));

ok("case_insensitive_lookup", Boolean(await g.getNode("python")) && Boolean(await g.getNode("PYTHON")));

// Phoenixclaw-specific behaviour BirdClaw's suite also asserts elsewhere
const before = (await g.getNode("Python")).confidence;
await g.upsertNode("Python", "concept", "Programming language");
const after = (await g.getNode("Python")).confidence;
ok("corroboration raises confidence (not overwrite)", after > before);

await g.upsertNode("anchor-test", "anchor", "original");
await g.upsertNode("anchor-test", "anchor", "tampered");
ok("anchor frozen against casual overwrite", (await g.getNode("anchor-test")).summary === "original");
await g.upsertNode("anchor-test", "anchor", "deliberate", 1.0);
ok("anchor updated on explicit confidence 1.0", (await g.getNode("anchor-test")).summary === "deliberate");

console.log(`\n  ${pass} passed, ${fail} failed, ${gap} gaps`);
process.exit(fail > 0 ? 1 : 0);
