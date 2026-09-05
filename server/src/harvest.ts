import { upsertNode, upsertEdge, neighbors, getNode } from "./graph.js";
import { ingestText } from "./ingest.js";
import { reconstructAssistantText } from "./transcript.js";
import { eventsSince, type SessionRow } from "./db.js";

/**
 * Harvest a conversation into the graph as it happens.
 *
 * Ports Sisyphean's `memory/session_merge.py` and `memory/extractor.py`, with
 * one change to each — see below.
 *
 * The graph had `graph_remember`, a Dream Cycle and a learning loop, and was
 * still empty of anything a person had said. After a full day of use it held
 * 25 nodes: 17 episodes the loop had written about itself, 5 identity anchors,
 * 2 concepts and one project. Zero facts. Asked to research a subject in one
 * conversation, the agent knew nothing about it in the next, because nothing
 * carried it across.
 *
 * Both existing write paths depend on something that does not reliably happen.
 * `graph_remember` is the model choosing to remember on a turn where it is busy
 * doing something else. The Dream Cycle needs `@idle` — ten minutes of quiet
 * *and* a three-hour gap — which a working day rarely offers, and which the
 * loop's own activity then consumes. Sisyphean's docstring says exactly this:
 * session_merge exists "to keep the graph current between dream cycle runs".
 *
 * ## Two tiers, because they fail differently
 *
 * 1. **The session node.** Composed from text alone — no model call, so it
 *    cannot be slow, cannot fail, and cannot be skipped because a local server
 *    is down. This is the tier that guarantees a conversation leaves a trace.
 * 2. **Extraction.** `ingestText` pulls propositions and entities from the new
 *    material using the local model. Better substance, but it needs that model
 *    and takes real time, so it runs after the reply has gone and its failure
 *    costs only the extras.
 *
 * ## Where this departs from Sisyphean
 *
 * **One node per session, re-composed rather than appended.** Sisyphean upserts
 * `session:<date>:<id>` on every end_turn so repeated turns "enrich the same
 * node rather than creating duplicates", and rebuilds its summary from the last
 * N requests and outcomes each time. Kept, because the alternative — a node per
 * turn — buries the graph in near-identical entries that then corroborate each
 * other. It also means tier 1 needs no watermark: re-composing from a bounded
 * window is idempotent by construction.
 *
 * **Tier 2 does need one.** Extraction writes *facts*, and re-reading the same
 * span would corroborate a passing remark into an established belief purely by
 * having read it twice. That is the failure the self-concept work already had
 * to undo once, so extraction only ever sees material it has not seen.
 *
 * Everything written here is low-confidence on purpose: it records that
 * something was *said*, which is a weaker claim than `graph_remember`'s "I
 * concluded this". Corroboration raises what turns out to matter; decay lets
 * the rest fade.
 */

/** Below this a turn is an acknowledgement, not a conversation. */
const MIN_HARVEST_CHARS = 80;

/** Sisyphean's caps, which are well judged: enough to recall, short enough to scan. */
const MAX_REQUESTS = 3;
const MAX_REQ_CHARS = 140;
const MAX_OUTCOMES = 4;
const MAX_OUTCOME_CHARS = 160;
const MAX_SUMMARY = 700;

/**
 * Recorded low: "this was said", not "this is so". `graph_remember` defaults to
 * 0.5 and states a conclusion the agent actually reached, which should outrank
 * a passing mention every time.
 */
const HARVEST_CONFIDENCE = 0.3;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the person asked, from the session's own portal_prompt events. */
async function prompts(sessionId: string, sinceSeq = 0): Promise<string[]> {
  const rows = await eventsSince(sessionId, sinceSeq, 1_000_000);
  const out: string[] = [];
  for (const row of rows) {
    if (row.type !== "portal_prompt") continue;
    try {
      const text = JSON.parse(row.payload)?.message;
      if (typeof text === "string" && text.trim()) out.push(squash(text));
    } catch {
      // A malformed row is not worth failing a harvest over.
    }
  }
  return out;
}

/** `conversation:<date>:<session>` — date-scoped so a long-lived chat still rolls over daily. */
const nodeNameFor = (session: SessionRow): string =>
  `conversation:${new Date().toISOString().slice(0, 10)}:${session.id}`;

/**
 * Attach this conversation to the one before it in the same workspace.
 *
 * Found through the workspace's own `scoped_to` neighbours rather than by
 * scanning every episode: the scope edge already answers "which conversations
 * happened here", so the previous one is the newest of those that is not this
 * one and is not already behind it.
 */
async function linkToPrevious(name: string, workspace: string): Promise<void> {
  if (!(await getNode(workspace))) return;
  const here = await neighbors(workspace);
  const conversations = here
    .filter((n) => n.type === "episode" && n.name.startsWith("conversation:") && n.name !== name)
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  const previous = conversations[0];
  if (previous) await upsertEdge(previous.name, "precedes", name);
}

export interface Harvest {
  node?: string;
  skipped?: string;
  /**
   * Tier 2, still running.
   *
   * Returned rather than awaited so the caller can let the next turn start
   * without waiting on a model call. The guaranteed record (tier 1) has already
   * been written by the time this resolves — the enrichment simply arrives for
   * the turn after, which is the right trade.
   */
  extraction: Promise<number>;
}

export async function harvestTurn(
  session: SessionRow,
  extractedTo: number,
): Promise<{ harvest: Harvest; seq: number }> {
  const nothing = Promise.resolve(0);
  // Tier 1 reads the whole session and keeps the most recent window, so it is
  // idempotent however often it runs. Tier 2 reads only what is new.
  const [asked, saidAll, saidNew] = await Promise.all([
    prompts(session.id),
    reconstructAssistantText(session.id, 0),
    reconstructAssistantText(session.id, extractedTo),
  ]);
  const seq = saidAll.length ? saidAll[saidAll.length - 1].seq : extractedTo;

  const recentAsked = asked.slice(-MAX_REQUESTS).map((a) => clip(a, MAX_REQ_CHARS));
  const recentSaid = saidAll
    .slice(-MAX_OUTCOMES)
    .map((c) => clip(squash(c.text), MAX_OUTCOME_CHARS));

  if (!recentAsked.length && !recentSaid.length) {
    return { harvest: { skipped: "nothing said yet", extraction: nothing }, seq };
  }

  // Minute precision, not just the day. "What did we say before this?" is a
  // question about order, and a date alone cannot order two conversations that
  // happened an hour apart — which is most of them.
  const parts = [`when: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`];
  if (recentAsked.length) parts.push(`they asked: ${recentAsked.join("; ")}`);
  if (recentSaid.length) parts.push(`you said: ${recentSaid.join("; ")}`);
  const summary = clip(parts.join(" | "), MAX_SUMMARY);

  if (summary.length < MIN_HARVEST_CHARS) {
    return { harvest: { skipped: "too short to be worth remembering", extraction: nothing }, seq };
  }

  const name = nodeNameFor(session);
  await upsertNode(name, "episode", summary, HARVEST_CONFIDENCE);

  // Scoped to the workspace it happened in, so a recall from that project finds
  // it and an unrelated one does not — the same `scoped_to` edge graph-tools
  // uses. A failure here costs scoping, not the memory.
  try {
    await upsertEdge(name, "scoped_to", session.workspace);
  } catch {
    /* an unscoped conversation is still worth having */
  }

  // A temporal spine, so the conversations have an order and not just
  // timestamps.
  //
  // Ports Sisyphean's `precedes` chaining (memory/memorise.py). Timestamps on
  // the rows already say *when*; an edge says *what came before this*, which is
  // the form the question is actually asked in — "what were we discussing
  // before that", "what changed since". Walking a chain also survives a clock
  // that is wrong, which sorting by created_at does not.
  //
  // Only the immediately previous conversation in the same workspace, and only
  // once: chaining to every earlier one would make the graph denser without
  // making it more answerable.
  try {
    await linkToPrevious(name, session.workspace);
  } catch {
    /* the spine is a convenience; the node itself is the record */
  }

  // --- tier 2: only the new material, started but not awaited ---
  const fresh = saidNew.map((c) => c.text).join("\n\n");
  const newAsked = (await prompts(session.id, extractedTo)).join("\n");
  const material = [newAsked, fresh].filter(Boolean).join("\n\n");
  const extraction =
    material.length >= MIN_HARVEST_CHARS
      ? ingestText(material, `conversation:${session.id}`, name)
          .then((r) => r.propositions ?? 0)
          // Swallowed deliberately: tier 1 is the guarantee, and a dead
          // extraction server must not stop a conversation being remembered.
          .catch(() => 0)
      : nothing;

  return { harvest: { node: name, extraction }, seq };
}
