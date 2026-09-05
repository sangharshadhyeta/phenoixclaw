/**
 * A direct line to the local model, for the portal's own small jobs.
 *
 * Not how the agent talks — that is pi, through a session. This is for work
 * the portal does *about* what the agent read: pulling propositions out of a
 * page, trimming text that keyword scoring handles badly. BirdClaw's ingest
 * pipeline is explicit about why that is affordable — "local model = unlimited
 * calls" — and the reasoning holds here: a llama-server on the same machine
 * has no per-token price, so a second pass over a page costs latency and
 * nothing else.
 *
 * Everything degrades to `undefined` rather than throwing. A page that could
 * not be summarised should still be readable, and an extraction that failed
 * should leave the graph as it was. Never take a feature down because an
 * optional improvement to it was unavailable.
 */

const BASE_URL = (process.env.LLAMA_BASE_URL || "").replace(/\/+$/, "");
const MODEL = process.env.LLAMA_MODEL || "local";
const TIMEOUT_MS = 120_000;

/**
 * Thinking is switched off, and that is the difference between this working
 * and not.
 *
 * The model here is a reasoning model, and its thinking comes out of the same
 * token budget as its answer. Asked to break two sentences into propositions
 * with 2048 tokens, it produced `finish_reason: "length"`, an empty `content`,
 * and 7,284 characters of `reasoning_content` — it deliberated until the
 * budget ran out and never answered. That failure is silent and looks exactly
 * like the model having nothing to say: the first version of the ingest
 * pipeline reported "1 proposition, 0 entities" on every document and gave no
 * hint why.
 *
 * Raising the ceiling only buys slower failures. The right fix is that none of
 * these jobs *wants* deliberation: copying the assertions out of a paragraph,
 * naming the entities in a list of facts, selecting the relevant sentences.
 * The material is already written down and the work is mechanical. With
 * thinking off the same call answers in one pass, and 64 seconds becomes a
 * fraction of that.
 *
 * `chat_template_kwargs` is passed through by llama.cpp to the chat template;
 * a server that does not understand it ignores it, so this is safe to send
 * unconditionally and the budget below still covers a model that thinks anyway.
 */
const NO_THINKING = { enable_thinking: false };
const DEFAULT_MAX_TOKENS = 2048;

export const localModelConfigured = (): boolean => Boolean(BASE_URL);

export async function complete(
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string | undefined> {
  if (!BASE_URL) return undefined;
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Low: every caller here condenses or extracts something already
        // written down, and invention is the failure mode.
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
        chat_template_kwargs: NO_THINKING,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as any;
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;
    // `reasoning_content` is deliberately ignored even when `content` is
    // empty: that is the model working out what to say, not what it decided.
    // Handing its own deliberation back as the answer is worse than nothing.
    if (typeof text !== "string" || !text.trim()) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/**
 * Pull a JSON array out of a completion.
 *
 * Small models fence their JSON, preface it, or trail an explanation after it
 * however plainly the prompt says not to. Taking the outermost brackets is
 * what makes this work on a 26B local model rather than only on a frontier
 * one — which is the whole point of running it here.
 */
export function parseJsonArray(text: string | undefined): unknown[] | undefined {
  if (!text) return undefined;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
