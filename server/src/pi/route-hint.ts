/**
 * A small, separate classification call, with thinking deliberately on.
 *
 * Ports Sisyphean's `route_query` (`translation/planner.py`), the one call in
 * either POC that keeps thinking enabled — everywhere else in this portal
 * (sampling.ts) suppresses it, because this model burns its output budget
 * reasoning rather than answering when it is left free to. `route_query` is
 * the deliberate exception, and the reason it stays safe where an ordinary
 * reply would not: its answer is one word from a five-item list, extractable
 * even from reasoning that never finishes, so a generation that spends its
 * whole 256-token budget deliberating still ends in a usable label rather
 * than nothing. An ordinary chat reply has no such fallback — tested directly
 * before building this, turning thinking on for the chat's own reply
 * generation reliably left it with an empty answer at a 1024-token ceiling.
 * So this is not "thinking on for the chat" — it is a second, disposable call
 * ahead of it, exactly as narrow as Sisyphean's.
 *
 * ## What it is for
 *
 * Advisory, never a gate. `needs-session.ts` — a harness classifier that
 * pre-empted the model's own turn — was removed for exactly the reason this
 * must not repeat it: the decision to hand work out belongs to the model,
 * informed by whatever it has, not decided for it before it runs. This is
 * one more thing to inform it with, appended as a note the same way
 * `arithmeticNote`/`worldQuestionNote` are — a hint, not a verdict. A failed,
 * empty, or unrecognised classification hands back "" and adds nothing,
 * which is the same non-blocking fallback `route_query` itself uses ("think_
 * decompose decides").
 */

const BASE_URL = (process.env.LLAMA_BASE_URL || "").replace(/\/+$/, "");
const MODEL = process.env.LLAMA_MODEL || "local";
const TIMEOUT_MS = 30_000;

export const ROUTE_LABELS = ["direct", "bash", "search", "memory", "code"] as const;
export type RouteLabel = (typeof ROUTE_LABELS)[number] | "";

const ROUTE_SYSTEM = `Classify this task into one category. Output the category name only — one word, no punctuation.

  direct  — a social reply or acknowledgement (hi, thanks, ok). Training knowledge is NOT context.
  bash    — can be computed or executed locally on this machine (no external data needed)
  search  — requires a factual lookup, current data, or anything not computable locally
  memory  — user wants to save or recall something
  code    — create or modify a file

Use direct ONLY for greetings and social replies. Any factual or informational question uses search.`;

/** One line, only for a label the conversation cannot act on directly. */
const HINTS: Record<Exclude<RouteLabel, "" | "direct">, string> = {
  bash: "This looks like it needs computation — a session with a shell can settle it.",
  search: "This looks like it needs a live lookup — a session can search for it.",
  memory: "This looks like something to save or recall.",
  code: "This looks like it needs a file created or changed — that is session work.",
};

/** First word of a string, lowercased, punctuation stripped. */
function firstWord(text: string): string {
  const match = /[a-z]+/i.exec(text);
  return match ? match[0].toLowerCase() : "";
}

/**
 * One classification call. Returns "" on anything that did not produce a
 * usable label — no server configured, a timeout, an unparseable response —
 * the same as Sisyphean's own `except Exception: return ""`.
 */
export async function routeQuery(query: string): Promise<RouteLabel> {
  if (!BASE_URL || !query.trim()) return "";
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: ROUTE_SYSTEM },
          { role: "user", content: query.slice(0, 200) },
        ],
        temperature: 0,
        max_tokens: 256,
        stream: false,
        // The one deliberate exception — see the file header. Left unset
        // rather than sent as `true`: a server that does not recognise the
        // field should see nothing here that looks like a request for a
        // capability it may not have.
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const body = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
    };
    const message = body?.choices?.[0]?.message;
    let raw = (message?.content ?? "").trim().toLowerCase();
    /**
     * The fallback `complete()` in llm.ts deliberately does not take:
     * reasoning as the answer. It is right to refuse that in general — a
     * model's deliberation is not its decision. This call is the one place
     * that is wrong, because Sisyphean's own router treats it as the
     * expected outcome, not a fallback of last resort: max_tokens=256 is
     * sized to be spent entirely on reasoning, with the label read off
     * whatever word it stopped on.
     */
    if (!raw) {
      const reasoning = (message?.reasoning_content ?? message?.reasoning ?? "").toLowerCase();
      const words = reasoning.split(/\W+/).filter(Boolean);
      raw = words[words.length - 1] ?? "";
    }
    const word = firstWord(raw);
    if ((ROUTE_LABELS as readonly string[]).includes(word)) return word as RouteLabel;
    // Fuzzy fallback: the label appears somewhere in a longer answer.
    for (const label of ROUTE_LABELS) {
      if (raw.includes(label)) return label;
    }
    return "";
  } catch {
    return "";
  }
}

/** The note to append, or "" for a label the conversation needs no hint for. */
export function routeHint(label: RouteLabel): string {
  if (!label || label === "direct") return "";
  return `\n\n${HINTS[label]}`;
}
