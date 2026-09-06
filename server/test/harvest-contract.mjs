/**
 * Harvesting a conversation into the graph.
 *
 * The graph had graph_remember, a Dream Cycle and a learning loop, and after a
 * full day of use held 25 nodes: 17 episodes the loop wrote about itself, 5
 * identity anchors, 2 concepts, one project. Zero facts. Asked to research a
 * subject in one conversation, the agent knew nothing about it in the next.
 *
 * Three properties have to hold together for that to stop being true, and each
 * of them was separately absent:
 *
 *   1. every turn leaves a record, without the model choosing to save one;
 *   2. what was extracted links back to the conversation it came from, so two
 *      conversations about a subject reach each other through it;
 *   3. conversations have an order, not just timestamps.
 *
 *     npm run test:harvest
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { harvestTurn } = await import(dist("harvest.js"));
const { getNode, neighbors, upsertNode } = await import(dist("graph.js"));
const { createSession, getSession, appendEvent } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const WS = "/workspaces/test";
async function session(id, title) {
  await createSession({ id, title, workspace: WS, executor: "host" });
  return getSession(id);
}
/** A finished turn, as the event log records one. */
async function turn(id, asked, said) {
  await appendEvent(id, "portal_prompt", { message: asked });
  await appendEvent(id, "message_update", { assistantMessageEvent: { type: "text_delta", delta: said } });
  await appendEvent(id, "message_end", {});
}

// --- 1. a turn is recorded without anyone choosing to record it -------------
const a = await session("sess-a", "first");
await turn("sess-a", "Research prediction markets, especially Polymarket resolution rules.", "Noted — I will look at Polymarket resolution.");
const first = await harvestTurn(a, 0);
await first.harvest.extraction;

ok("a conversation produces a node", Boolean(first.harvest.node));
ok("named per session and date", /^conversation:\d{4}-\d\d-\d\d:sess-a$/.test(first.harvest.node));
const node = await getNode(first.harvest.node);
ok("it records what was asked", /Polymarket/i.test(node.summary));
ok("it records what was answered", /you said/i.test(node.summary));
ok("it carries a time, not just a date", /when: \d{4}-\d\d-\d\d \d\d:\d\d/.test(node.summary));
ok("recorded low — it was said, not established", node.confidence <= 0.35);
ok("scoped to the workspace it happened in",
   (await neighbors(first.harvest.node)).some((n) => n.relation === "scoped_to"));

// --- 2. re-harvesting the same session enriches one node, not many ----------
await turn("sess-a", "Also look at UMA oracle disputes.", "Understood, UMA disputes too.");
const second = await harvestTurn(a, first.seq);
await second.harvest.extraction;
ok("the same session keeps one node", second.harvest.node === first.harvest.node);
const grown = await getNode(first.harvest.node);
ok("and that node takes in the newer turn", /UMA/i.test(grown.summary));
ok("while still holding the earlier one", /Polymarket/i.test(grown.summary));

// --- 3. conversations are ordered ------------------------------------------
const b = await session("sess-b", "second");
await turn("sess-b", "Back to Polymarket — how are disputes settled?", "Through the UMA optimistic oracle.");
const third = await harvestTurn(b, 0);
await third.harvest.extraction;

const around = await neighbors(third.harvest.node);
ok("a later conversation is chained to the one before it",
   around.some((n) => n.relation === "precedes" && n.name === first.harvest.node));
ok("the spine runs one way only",
   !around.some((n) => n.relation === "precedes" && n.direction === "out"));

// --- 4. attribution: a subject leads back to who discussed it --------------
// Extraction needs the local model, so the link is asserted directly here and
// end-to-end by hand; what must hold unconditionally is that a shared subject
// connects two conversations that never met.
await upsertNode("Polymarket", "concept", "A prediction market.", 0.4);
const { upsertEdge } = await import(dist("graph.js"));
await upsertEdge(first.harvest.node, "mentions", "Polymarket");
await upsertEdge(third.harvest.node, "mentions", "Polymarket");

const viaSubject = (await neighbors("Polymarket")).filter((n) => n.relation === "mentions");
ok("a subject knows which conversations mentioned it", viaSubject.length === 2);
ok("including one that never saw the other",
   viaSubject.some((n) => n.name === first.harvest.node) &&
   viaSubject.some((n) => n.name === third.harvest.node));

// --- 5. nothing worth remembering is not remembered ------------------------
const c = await session("sess-c", "trivial");
await turn("sess-c", "ok", "Understood.");
const nothing = await harvestTurn(c, 0);
await nothing.harvest.extraction;
ok("a bare acknowledgement is skipped", nothing.harvest.node === undefined);
ok("and says why", /too short|nothing said/.test(nothing.harvest.skipped ?? ""));

// --- 6. extraction is detached, and its absence costs only the extras ------
ok("tier 2 is handed back as a promise", typeof first.harvest.extraction?.then === "function");
ok("a missing local model does not lose the record", Boolean(first.harvest.node));

// --- the record keeps the person's own words, not a paraphrase -------------
// A model-written summary was tried here and removed: summarising is the
// compression step of an accumulate-and-compact context, and once context is
// assembled by search there is nothing to compress. For finding, a paraphrase
// is actively worse — search matches words, and the words worth matching are
// the ones the person used.
{
  const d = await session("sess-d", "verbatim");
  await turn("sess-d", "We are moving our vector store from Chroma to Qdrant.", "Understood.");
  const h = await harvestTurn(d, 0);
  await h.harvest.extraction;
  const node = await getNode(h.harvest.node);
  ok("the searchable terms survive verbatim", /Chroma/.test(node.summary) && /Qdrant/.test(node.summary));
  ok("and so does the phrasing around them", /vector store/.test(node.summary));
}

// --- a short message still yields its entities -----------------------------
// The model pass has a threshold because it costs a call; the regex pass does
// not, and shared thresholds meant a 79-character sentence naming a file and an
// error type extracted nothing at all. One character short.
{
  const { getNode } = await import(dist("graph.js"));
  const h = await session("sess-short", "short");
  await turn("sess-short", "The bug is in server/src/pi/guard.ts and it throws TypeError.", "Noted.");
  const out = await harvestTurn(h, 0);
  await out.harvest.extraction;

  ok("a short technical message is still mined", Boolean(await getNode("server/src/pi/guard.ts")));
  ok("including the error type", Boolean(await getNode("TypeError")));
  ok("and the conversation is recorded as usual", Boolean(out.harvest.node));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
