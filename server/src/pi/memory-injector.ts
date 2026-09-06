import { personalRecall, type NodeRow } from "../graph.js";
import { asked } from "./asked.js";
import { priorWorkBlock, priorWorkFrom } from "./prior-work.js";
import { semanticPrune } from "../ingest.js";
import { appendEvent } from "../db.js";

/**
 * Search memory before answering — Sisyphean's `memory/injector.py`, as a
 * per-turn hook rather than a stage in a pipeline.
 *
 * The graph had every tool it needed and was still effectively write-only,
 * because *recall was the model's decision*. Asked "what did we discuss last
 * about you being alive, and what did I promise?", a session did this:
 *
 *     read identity/INNER_LIFE.md   → ENOENT
 *     ls . ; ls . ; find identity/*.md ; ls . ; ls / ; ls /workspaces/
 *
 * — eight calls hunting the filesystem for something that was sitting in the
 * graph the whole time, and never once calling `graph_recall`. A tool the model
 * has to think of is a tool it will sometimes not think of, and "sometimes" is
 * every turn where it matters most: the ones where it does not already know.
 *
 * So the search happens whether or not the model asks for it. What comes back
 * is attached to the turn's system prompt, and the model starts from what it
 * has recorded instead of from nothing.
 *
 * **What is injected is a lead, not an answer.** The framing below says so
 * explicitly. A recalled node is something this agent wrote down once, at some
 * confidence, possibly from a web page — not a fact about the world. Anything
 * load-bearing gets checked; the graph says *where to look* and *what it
 * previously concluded*, which is exactly what "verify, don't recall" needs it
 * to say and no more.
 */

/**
 * How many hits are considered, and how much of them reaches the prompt.
 *
 * These are different numbers on purpose. A narrow search is not the problem —
 * a *good* one is: ask about a subject the agent has worked on for weeks and
 * the graph returns everything it ever recorded about it, which is exactly
 * when recall is most valuable and least able to fit.
 *
 * So retrieval is generous and the *rendering* is budgeted. Under the budget
 * the hits go in verbatim, because verbatim is what search matched and the
 * agent's own words are worth keeping. Over it, the set is condensed against
 * the question actually asked — see below.
 */
const CONSIDER_ITEMS = 20;
const MAX_ITEMS = 6;

/**
 * Characters of memory the prompt will carry before condensing.
 *
 * BirdClaw's number, and its reasoning. `memory/retrieval.py` caps injected
 * memory at 300 tokens — "the output is injected into the agent's system
 * prompt — it must be short" — with three seed nodes and two hops, and then
 * passes the conversation through untouched (`agent/loop.py`). Search is a
 * *supplement* to what the agent is doing, not a substitute for it.
 *
 * That ordering matters more than the number. An agent that recalls plenty and
 * has lost the thread of the task in hand is worse than one that recalls
 * little: the work is what it is here to do, and re-deriving it costs far more
 * than the tokens the recall saved.
 */
const RENDER_BUDGET = 1200;

/** Below this a prompt is "ok", "yes", "continue" — nothing to search for. */
const MIN_QUERY_CHARS = 12;

/** Cheap guard against spending a search on a prompt with no content words. */
const TRIVIAL = /^(ok(ay)?|yes|no|sure|thanks?|continue|go on|carry on|do it|next|stop|\W*)$/i;

/**
 * `user` nodes are the primary user's own notes and travel only in their own
 * conversations — the same boundary PrimaryUser.md and MEMORY.md follow in
 * sdk-client.ts. Without this a colleague asking an innocuous question would
 * get the primary user's preferences recalled into the answer.
 */
const visibleTo = (role: string | undefined, rows: NodeRow[]): NodeRow[] =>
  !role || role === "primary" ? rows : rows.filter((r) => r.type !== "user");

/**
 * A record of something that happened, as against a belief about the world.
 *
 * "Verify, don't recall" governs claims — a fact read off a page, a conclusion
 * drawn. It does not govern what was said: the agent was present, an `episode`
 * has a time on it, and hedging that reads as the agent doubting its own
 * experience. `anchor` is its own identity, which is likewise not a claim.
 */
const isRecord = (r: NodeRow) => r.type === "episode" || r.type === "anchor";

/** Relative where that reads naturally, absolute once it stops. */
const when = (iso: string): string => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return then.toISOString().slice(0, 10);
};

/**
 * One line per hit.
 *
 * Records lead with *when*: remembering across time is the point, and a memory
 * with no date is half a memory — "you told me on Tuesday" and "you told me at
 * some stage" are different things to be able to say. Beliefs lead with the
 * confidence they were recorded at, which is what decides whether they need
 * checking before use.
 */
/**
 * Where a recalled record came from, said out loud.
 *
 * A memory that arrives with no provenance is indistinguishable from something
 * happening now, and an agent that cannot tell "we are discussing this" from
 * "we discussed this in March" will answer as though the older thing is still
 * in progress. Conversation nodes are named `conversation:<date>:<sessionId>`,
 * so the current session's own id is enough to separate *here, earlier* from
 * *somewhere else, then* — and the two need saying differently.
 */
function provenance(r: NodeRow, sessionId: string | undefined): string {
  const stamp = when(r.last_seen || r.created_at);
  const match = /^conversation:(\d{4}-\d\d-\d\d):(.+)$/.exec(r.name);
  if (!match) return stamp ? `${stamp}` : "";
  const isHere = sessionId !== undefined && match[2] === sessionId;
  if (isHere) return `earlier in this conversation${stamp ? `, ${stamp}` : ""}`;
  return `in a different conversation${stamp ? `, ${stamp}` : ""}`;
}

function render(rows: NodeRow[], sessionId?: string): string {
  const records = rows.filter(isRecord);
  const beliefs = rows.filter((r) => !isRecord(r));
  const lines: string[] = [];

  if (records.length) {
    lines.push("What happened, and when:");
    for (const r of records) {
      const from = provenance(r, sessionId);
      lines.push(`- ${from ? `[${from}] ` : ""}${r.summary.replace(/\s+/g, " ").trim().slice(0, 260)}`);
    }
  }
  if (beliefs.length) {
    if (lines.length) lines.push("");
    lines.push("What you have concluded or read:");
    for (const r of beliefs) {
      const summary = r.summary.replace(/\s+/g, " ").trim().slice(0, 220);
      lines.push(`- ${r.name} (${r.type}, confidence ${r.confidence.toFixed(2)}): ${summary}`);
    }
  }
  return lines.join("\n");
}

/**
 * Fit what was retrieved into the prompt.
 *
 * Under budget, everything goes in as it was written. Over it — a large search,
 * which is what a well-used graph produces on its best subjects — the set is
 * condensed against the question, keeping the lines that bear on it and
 * dropping the rest.
 *
 * `semanticPrune` rather than a summariser: it *selects* sentences verbatim
 * instead of paraphrasing them, which matters here for the same reason the
 * harvest keeps the person's own words — a paraphrase of "move from Chroma to
 * Qdrant" into "database migration" throws away the terms that made this
 * relevant in the first place. It also degrades to keyword selection with no
 * local model, so a large recall is never simply truncated at an arbitrary
 * point.
 *
 * Falls back to the top few hits if condensing returns nothing, so this can
 * only ever improve on the cut.
 */
async function condense(
  full: string,
  question: string,
  rows: NodeRow[],
  sessionId?: string,
): Promise<string> {
  try {
    const condensed = (await semanticPrune(full, question, RENDER_BUDGET)).trim();
    if (condensed) return condensed;
  } catch {
    /* fall through to the plain cut */
  }
  return render(rows.slice(0, MAX_ITEMS), sessionId);
}

export function memoryInjector(cwd: string, role?: string, sessionId?: string) {
  return (pi: any): void => {
    pi.on("before_agent_start", async (event: any) => {
      /**
       * Search with what was said, not with what the portal appended to it.
       * See asked.ts — the recall for "what is the square root of 144?" was
       * being run against that question plus three paragraphs of arithmetic
       * note, and returned a fact node named `25`.
       */
      const prompt = asked(String(event?.prompt ?? ""));
      if (prompt.length < MIN_QUERY_CHARS || TRIVIAL.test(prompt)) return undefined;

      let rows: NodeRow[];
      try {
        // personalRecall rather than scopedRecall: a conversation is with the
        // person, not with the directory they happened to be standing in. Only
        // genuinely project-bound memory stays fenced — see graph.ts.
        rows = visibleTo(role, await personalRecall(prompt, cwd, CONSIDER_ITEMS));
      } catch {
        // A failed recall must never cost the user their turn. The model still
        // has graph_recall and can ask for itself.
        return undefined;
      }
      if (!rows.length) return undefined;

      const full = render(rows, sessionId);
      const block = [
        "",
        "# YOUR MEMORY OF THIS",
        "",
        "Retrieved from your own memory by searching it with what was just said — you did",
        "not have to ask for it. You remember across time and across conversations, and",
        "speaking from this is not guesswork.",
        "",
        /**
         * Permission to ignore a hit that does not fit.
         *
         * This block used to assert that memory is yours and authoritative,
         * and stop there. A search returns what is *near* the question, not
         * what answers it — so asked for the square root of 144 the turn was
         * handed a fact node named `25`, left over from an earlier 100/4.
         * With nothing saying a hit may be irrelevant, that is a contradiction
         * the turn has to resolve before it can answer: its own memory says 25
         * and the arithmetic says 12. It went round that for eight thousand
         * tokens and never answered at all.
         *
         * A retrieval that cannot be dismissed is worse than none. The line
         * out has to be in the block itself, because the block is the thing
         * doing the pushing.
         */
        "This is a search, so some of it will simply not be about your question. Anything",
        "that does not fit is a near miss, not a claim you have to reconcile or argue with",
        "— drop it and move on. A number here that disagrees with a number you just",
        "computed is the old one being wrong or being about something else; what you ran",
        "wins, every time. Do not spend the turn deciding: nothing below outranks the",
        "thing in front of you.",
        "",
        "Two different things are below and they are not alike. What happened is a record",
        "— you were there, it has a time on it, and you can say so plainly. What you",
        "concluded or read is a belief, held at some confidence, and it may be stale or",
        "may have come from a page rather than from the person you work for: if one of",
        "those is load-bearing for your answer, check it rather than repeat it.",
        "",
        "Mind where each one is from. Anything marked as being from a different",
        "conversation is not what is happening now — it is something you did or were",
        "told at another time, and it does not carry over as though it were still in",
        "progress. Say so when you use it: \"you mentioned this a few days ago\" rather",
        "than answering as if it were the thread you are both in. Whatever you are",
        "working on right now is in the conversation itself, below this.",
        "",
        full.length > RENDER_BUDGET ? await condense(full, prompt, rows, sessionId) : full,
        /**
         * Something this agent has built before, if the recall turned one up.
         *
         * Hung off the search that has already happened rather than a second
         * one. An artefact node reaching the model as one more memory line —
         * "written to /workspaces/session-x/geometry.mjs" — is true and
         * useless: nothing tells it to go and read the thing, so each run
         * writes from nothing and the second attempt is different rather than
         * better. See prior-work.ts.
         */
        priorWorkBlock(priorWorkFrom(rows, cwd)),
      ].join("\n");

      /**
       * Leave a record of what this turn was given, and why.
       *
       * An autonomous iteration is judged entirely by what it did, and the
       * audit log answers that — read this, grepped that. What it cannot answer
       * is the more useful question: what did the agent *know* when it decided
       * to? A loop that reads pi's README twenty times looks stubborn until you
       * can see that its memory returned nothing relevant each time, at which
       * point it looks like a retrieval problem, which is what it was.
       *
       * Written as an ordinary event, so it replays with the transcript, is
       * visible through the existing API, and can be asserted on in a test —
       * rather than as a table nothing else knows how to read.
       */
      if (sessionId) {
        void appendEvent(sessionId, "portal_context", {
          query: prompt.slice(0, 200),
          considered: rows.length,
          shown: Math.min(rows.length, MAX_ITEMS),
          condensed: full.length > RENDER_BUDGET,
          recalled: rows.slice(0, MAX_ITEMS).map((r) => ({
            name: r.name,
            type: r.type,
            confidence: Number(r.confidence.toFixed(2)),
          })),
        }).catch(() => {
          // A missing trace must never cost the turn it was tracing.
        });
      }

      // Appended, never replacing: pi chains this result across extensions, so
      // returning a bare string here would discard the assembled prompt (and
      // anything another extension added before us).
      return { systemPrompt: `${String(event?.systemPrompt ?? "")}\n${block}` };
    });
  };
}
