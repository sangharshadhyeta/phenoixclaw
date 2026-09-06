import { upsertNode, upsertEdge, neighbors, getNode } from "./graph.js";
import { ingestText } from "./ingest.js";
import { reconstructAssistantText } from "./transcript.js";
import { eventsSince, type SessionRow } from "./db.js";
import { rememberUser, type UserCategory } from "./user-knowledge.js";
import { nextWeekday } from "./pi/temporal-context.js";

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

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Pin relative dates to real ones, while they are still unambiguous.
 *
 * "I have a meeting on Thursday" is perfectly clear when said and meaningless
 * a fortnight later: recalled in isolation it cannot say whether that Thursday
 * is coming or long gone, and the agent will happily repeat it as though it
 * were still ahead. The conversation's own timestamp is what disambiguates it,
 * and that is only to hand at the moment of recording.
 *
 * So the resolution happens here rather than at recall. This is the whole
 * answer to whether a separate calendar is needed: it is not, provided the
 * graph stores what a relative reference *resolved to* rather than the words
 * that produced it. A date is a fact; "Thursday" is a fact plus the day it was
 * uttered.
 *
 * Annotated rather than substituted — "Thursday (2026-09-10)" — because the
 * original wording is what a later search will match on, and a bare date would
 * lose it. A bare weekday is read as the *next* one, which is what it almost
 * always means in speech; the annotation makes that reading visible so it can
 * be contradicted rather than silently assumed.
 */
export function pinDates(text: string, said: Date): string {
  return text.replace(
    /\b(last |next |this |on |by |before |after )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    (match, lead: string | undefined, day: string) => {
      const index = WEEKDAYS.indexOf(day.toLowerCase());
      if (index < 0) return match;
      const prefix = (lead ?? "").trim().toLowerCase();
      const target = nextWeekday(said, index);
      if (prefix === "last") target.setDate(target.getDate() - 7);
      return `${match} (${target.toISOString().slice(0, 10)})`;
    },
  );
}
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

/**
 * `conversation:<date>:<session>`, or `iteration:<date>:<routine>` for a run
 * nobody asked for.
 *
 * Named apart because they are different things and are read differently: a
 * conversation is something the person was part of, an iteration is the agent
 * working alone. Recalling one as the other would have the agent tell you
 * "you asked me to read pi's README", which nobody did.
 *
 * Date-scoped either way, so a long-lived session rolls over daily rather than
 * growing one node forever.
 */
const nodeNameFor = (session: SessionRow): string => {
  const day = new Date().toISOString().slice(0, 10);
  return session.kind === "routine" && session.routine_slug
    ? `iteration:${day}:${session.routine_slug}`
    : `conversation:${day}:${session.id}`;
};

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

/**
 * First-person statements about the person, and which drawer they belong in.
 *
 * Two things go wrong without this. "My favourite colour is vermilion" was
 * stored only inside a conversation episode, so answering "what colour tie
 * should I wear" required the model to *search* for it — and searching is
 * something it has to think of doing. It did not, and asked what colour the
 * shirt was instead. Meanwhile `remember_user` sat unused, because it too is a
 * tool the model must choose to call while it is busy answering.
 *
 * What the person says about themselves belongs in the block that is injected
 * every turn regardless of the question (userKnowledgeExcerpt, in the system
 * prompt), not in the tier that has to be found. A preference is not something
 * to look up; it is something to know.
 *
 * Matched on the shape of the sentence rather than by asking a model: "I
 * prefer", "my favourite", "I always", "I hate". Cheap, no call, and it fails
 * by not matching rather than by inventing — a sentence that is not obviously
 * about the speaker simply goes to the ordinary extractor instead.
 */
const PERSONAL: { pattern: RegExp; category: UserCategory }[] = [
  { pattern: /\bI (?:prefer|like|love|hate|dislike|want|need|would rather)\b/i, category: "preferences" },
  { pattern: /\bmy (?:favourite|favorite|preferred)\b/i, category: "preferences" },
  { pattern: /\bI (?:always|never|usually|tend to|generally)\b/i, category: "behaviors" },
  { pattern: /\bI(?:'m| am) (?:interested in|working on|learning|into)\b/i, category: "interests" },
  { pattern: /\b(?:I am|I'm|my name is|I work|I run|I use|I have)\b/i, category: "facts" },
];

/** Sentences, so one aside does not drag a whole paragraph into user knowledge. */
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 10 && x.length < 300);

/**
 * File what the person said about themselves where it will always be read.
 *
 * Returns how many landed. Failures are swallowed per sentence: this is an
 * improvement on the record, and the episode already holds the words verbatim.
 */
async function harvestPersonalFacts(asked: string[]): Promise<number> {
  let kept = 0;
  for (const sentence of asked.flatMap(sentences)) {
    const match = PERSONAL.find((p) => p.pattern.test(sentence));
    if (!match) continue;
    try {
      await rememberUser(sentence, match.category);
      kept++;
    } catch {
      /* the verbatim record already has it */
    }
  }
  return kept;
}

export interface Harvest {
  node?: string;
  skipped?: string;
  /** How many first-person statements were filed as user knowledge. */
  personal?: number;
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

  // Dates pinned against the moment the conversation happened, which is the
  // only time they are unambiguous — see pinDates.
  const now = new Date();
  const recentAsked = asked.slice(-MAX_REQUESTS).map((a) => clip(pinDates(a, now), MAX_REQ_CHARS));
  const recentSaid = saidAll
    .slice(-MAX_OUTCOMES)
    .map((c) => clip(pinDates(squash(c.text), now), MAX_OUTCOME_CHARS));

  if (!recentAsked.length && !recentSaid.length) {
    return { harvest: { skipped: "nothing said yet", extraction: nothing }, seq };
  }

  // Minute precision, not just the day. "What did we say before this?" is a
  // question about order, and a date alone cannot order two conversations that
  // happened an hour apart — which is most of them.
  const parts = [`when: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`];
  const alone = session.kind === "routine";
  // A routine's "prompt" is its own standing instructions, identical every
  // run. Recording it would say nothing and crowd out what actually happened.
  if (!alone && recentAsked.length) parts.push(`they asked: ${recentAsked.join("; ")}`);
  if (recentSaid.length) parts.push(`${alone ? "you did" : "you said"}: ${recentSaid.join("; ")}`);
  const summary = clip(parts.join(" | "), MAX_SUMMARY);

  if (summary.length < MIN_HARVEST_CHARS) {
    return { harvest: { skipped: "too short to be worth remembering", extraction: nothing }, seq };
  }

  /**
   * Composed from the text, not written by a model — and deliberately so.
   *
   * A model-written summary was tried here and removed. Summarising a
   * conversation is what you do when the conversation has to *fit*: it is the
   * compression step of an accumulate-and-compact context, and pi's own
   * summariser exists to serve exactly that. Once context is assembled by
   * search (context-assembler.ts) there is nothing to compress — what is
   * needed is not a shorter conversation but a findable one.
   *
   * And for finding, a paraphrase is worse. Search matches words, and the
   * words most likely to be searched for are the ones the person actually
   * used. A summary that renders "move our vector store from Chroma to
   * Qdrant" as "discussed database migration options" has lost precisely the
   * terms that would have retrieved it. Keeping their phrasing verbatim costs
   * a model call less and recalls better.
   *
   * Meaning is not lost by this: it is tier 2's job, which extracts entities
   * and the relations between them, and links them back here.
   */
  const name = nodeNameFor(session);
  await upsertNode(name, "episode", summary, HARVEST_CONFIDENCE, {
    source: session.kind === "routine" ? `routine:${session.routine_slug}` : `session:${session.id}`,
  });

  // What they said about themselves goes where it is always read, not only
  // where it can be searched — see harvestPersonalFacts.
  // Only from a real conversation: a routine's "I" is the agent talking to
  // itself, and filing that as something the person told you about themselves
  // is how the user-knowledge block fills up with the agent's own voice.
  const personal =
    session.kind === "routine" ? 0 : await harvestPersonalFacts(asked.slice(-MAX_REQUESTS)).catch(() => 0);

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

  /**
   * Tier 2 reads what the *person* said, and not what the agent answered.
   *
   * Mining its own output turned a mistake into a belief. Asked what day it
   * was — before anything told it — the agent guessed "Friday, September 5,
   * 2026", and the extractor dutifully filed `September 5, 2026 (fact): "The
   * current date."`. From then on every turn carried a memory contradicting
   * the real date, and the model had to reason its way out of the conflict
   * before answering anything:
   *
   *     "This is contradictory. However, the TODAY section is usually the most
   *      reliable source... I will go with the TODAY block."
   *
   * It got there, and it should never have had to. An agent that harvests its
   * own answers as evidence corroborates itself: the second telling is not
   * confirmation, it is the same claim heard twice, and confidence rises
   * anyway. That is the entrenchment loop the self-concept work already had to
   * break for identity, arriving again for facts.
   *
   * So the person is the source. What they say about themselves and their work
   * is evidence; what the agent concluded is a conclusion, and it has
   * `graph_remember` to record one deliberately when it is worth keeping. The
   * verbatim record above is unaffected — tier 1 still holds both halves of the
   * exchange, because what was *said* is a record either way.
   */
  const material = (await prompts(session.id, extractedTo)).join("\n");
  const extraction =
    material.length >= MIN_HARVEST_CHARS
      ? ingestText(material, `conversation:${session.id}`, name)
          .then((r) => r.propositions ?? 0)
          // Swallowed deliberately: tier 1 is the guarantee, and a dead
          // extraction server must not stop a conversation being remembered.
          .catch(() => 0)
      : nothing;

  return { harvest: { node: name, personal, extraction }, seq };
}
