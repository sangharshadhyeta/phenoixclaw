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

// --- faithfulness: a claim enters at the confidence its source supports ---
{
  const { faithfulness } = await import(dist("ingest.js"));
  const source = "The deployment pipeline runs on GitHub Actions and rolls back by re-running the previous workflow.";

  const drawn = faithfulness("The deployment pipeline runs on GitHub Actions.", source);
  const invented = faithfulness("The deployment pipeline requires manual approval from two reviewers.", source);

  ok("a claim carried by its source scores high", drawn > 0.9);
  ok("one the model supplied scores low", invented < 0.6);
  ok("and the gap between them is the signal", drawn - invented > 0.3);
  ok("an empty claim scores nothing", faithfulness("", source) === 0);
  ok("a claim of only short words does not divide by zero",
     Number.isFinite(faithfulness("a an of", source)));
}

// --- the standing practices are actually in the prompt --------------------
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/pi/sdk-client.ts", import.meta.url), "utf8");
  const framing = src.slice(src.indexOf("async function framing"), src.indexOf("export function builtinSkillsDir"));
  ok("computation is routed to a tool", /Compute rather than guess/.test(framing));
  ok("and names bash specifically", /put them through `bash`/.test(framing));
  ok("verification is asked for what is load-bearing", /Check rather than recall/.test(framing));
  ok("and memory is framed as a start, not an authority", /not an authority/.test(framing));

  /**
   * The hedge had to go, and the line had to be drawn.
   *
   * "when it matters" was an out, and the model took it: asked for the capital
   * of France it reasoned "I know this fact" and answered without checking
   * anything. The distinction that actually holds is not how important the
   * question is but whose the answer is — reasoning done now is the model's,
   * a fact about the world is not.
   */
  ok("the 'when it matters' hedge is gone", !/Check rather than recall, when it matters/.test(framing));
  ok("reasoning is separated from facts about the world", /Reasoning you do now is yours/.test(framing));
  ok("and confidence is refused as evidence", /how sure/.test(framing) && /is not evidence/.test(framing));
  /**
   * Saying which you did is the part that survives a missing tool. Web search
   * is off on this deployment, so "go and look" is sometimes impossible — and
   * an unverified answer labelled as unverified is still honest.
   */
  ok("answering from memory must be declared", /from memory, not verified/.test(framing));
  /**
   * Twice a session hit something it could not do and wrote the same sentence
   * to itself forty times — "I'll try to use `bash` with `ls /`", "I'll just
   * say Paris" — until a person killed it. Nothing had said stopping was one
   * of the options.
   */
  /**
   * Told to check the capital of France, a session ran
   * `echo "Paris" | grep -v "Paris"` — its own answer, fed in and read back.
   * It satisfies "run a command" exactly and can only ever agree with whatever
   * went in.
   */
  ok("a check must be able to disagree", /able to disagree with you/.test(framing));
  ok("naming the shapes that cannot", /echoing your own answer/.test(framing));
  ok("and why that is worse than not checking", /agree with/.test(framing) && /every time including the times you are wrong/.test(framing));

  ok("being unable is stated to be a complete answer", /complete answer/.test(framing));
  ok("with the three things to report", /what you tried/.test(framing) && /what it prevents/.test(framing));
  ok("retrying the same tool is closed off", /Do not call the same tool again/.test(framing));
  ok("and so is quietly answering anyway", /hides the gap is worse than no answer/.test(framing));
  // Stated before the first token rather than enforced at the tool call:
  // refusing a large write after the fact only throws away a generation that
  // has already thinned.
  ok("output with parts is planned in pieces", /one part at a time/.test(framing));
  ok("naming the tools", /write_plan/.test(framing) && /write_next/.test(framing));
  ok("with the reason, not just the rule", /attention thins/.test(framing));
  ok("and something with no parts is left alone", /`write` is for something with no parts/.test(framing));

  /**
   * The criterion is structure, not length — and it says so explicitly.
   *
   * The wording it replaced said "anything past a couple of pages", and a live
   * session reasoned its way straight out of it: "I'll just use `write` for a
   * single file since it's not 'long' in the sense of a book, but it's a
   * module" — then wrote four documented functions in one call. Almost nothing
   * is a book, so a length test is a test almost nothing passes.
   */
  ok("the test is named as structure rather than length", /not length, it is structure/.test(framing));
  ok("with a number low enough to bind", /Two functions is enough/.test(framing));
  ok("and the book comparison closed off explicitly", /against a book/.test(framing));
}

// --- the graph as something you can draw ----------------------------------
// `neighbors` answers "what is next to this", which is right for the agent and
// wrong for a picture: drawing a hundred nodes that way is a hundred round
// trips, and what you get depends on where you started.
{
  const { graphSnapshot, upsertEdge } = await import(dist("graph.js"));

  await g.upsertNode("alpha module", "concept", "A module.", 0.9);
  await g.upsertNode("beta module", "concept", "Another module.", 0.9);
  await g.upsertNode("lonely thought", "concept", "Connected to nothing.", 0.9);
  await upsertEdge("alpha module", "imports", "beta module");

  const snap = await graphSnapshot(200);
  ok("nodes come back", snap.nodes.length > 0);
  ok("edges come back", snap.edges.length > 0);
  ok("an edge names both ends",
     snap.edges.some((e) => e.source === "alpha module" && e.target === "beta module"));
  ok("with its relation", snap.edges.some((e) => e.relation === "imports"));

  // An edge to a node that was cut is a line to nowhere, not a hint of
  // something beyond the frame.
  const ids = new Set(snap.nodes.map((n) => n.id));
  ok("no edge dangles",
     snap.edges.every((e) => ids.has(e.source) && ids.has(e.target)));

  // A truncated graph should be the interesting part of it, not the first
  // rows on disk.
  const small = await graphSnapshot(3);
  ok("the limit is respected", small.nodes.length === 3);
  ok("and the strongest come first",
     small.nodes[0].confidence >= small.nodes[small.nodes.length - 1].confidence);

  const typed = await graphSnapshot(50, "concept");
  ok("filtering by type works", typed.nodes.every((n) => n.type === "concept"));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
