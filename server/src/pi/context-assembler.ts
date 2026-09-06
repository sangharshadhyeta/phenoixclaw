import { getNode } from "../graph.js";

/**
 * Assemble the context for each request instead of accumulating it.
 *
 * Sisyphean's premise, and the reason its engine exists at all: the whole chat
 * is not the context. What the model should see is the system prompt, what has
 * been *retrieved* as relevant, and the task in hand — not every exchange that
 * has happened since the session opened.
 *
 * pi does the conventional thing: it keeps the full conversation and compacts
 * when it no longer fits. That is the right default for a coding CLI, where the
 * last hour of edits genuinely is the working set. It is the wrong default for
 * an agent whose memory is a graph, because it means the graph is a place facts
 * are *filed* rather than the place they are *read from* — the model answers
 * from whatever happens to still be in the window, and compaction decides what
 * that is by summarising rather than by relevance.
 *
 * `before_provider_request` is the seam. pi chains each handler's return value
 * into the payload actually sent (`extensions/runner.ts`'s
 * emitBeforeProviderRequest, wired through `sdk.ts`'s onPayload and applied at
 * `ai/src/api/openai-completions.ts`), so what this returns *is* the request.
 *
 * ## What it does
 *
 * Keeps the leading system messages, keeps the most recent exchanges intact,
 * and replaces everything older with a pointer into memory — where those
 * exchanges have already been harvested (see harvest.ts). The system prompt
 * already carries what the memory injector retrieved for this turn, so the
 * assembled context is: identity + retrieved memory + recent work + the
 * request.
 *
 * ## What it deliberately will not do
 *
 * **It never cuts inside a turn.** A turn is a user message and everything that
 * follows it — assistant messages, tool calls, and the tool results those calls
 * are paired with. Split one and the provider is handed a tool result whose
 * call is missing, which is a hard API error rather than a degraded answer. So
 * the cut is always at a `user` boundary, and the current turn is never touched
 * at all.
 *
 * **It passes through anything it does not recognise.** A payload whose shape
 * is unfamiliar is forwarded untouched. Every provider builds its body
 * differently and this runs on the request path of every single call: the
 * failure mode of being too cautious is a longer prompt, and the failure mode
 * of being too clever is a session that cannot talk to its model at all.
 */

/**
 * Exchanges kept verbatim, counted in user messages.
 *
 * Generous rather than minimal. The recent window is where the actual work is,
 * and a model that has lost the thread of what it is doing will redo it —
 * which costs far more than the tokens saved. Trimming starts only past this,
 * and only when the token ceiling below has not already forced it further in.
 */
const KEEP_EXCHANGES = Number(process.env.CONTEXT_KEEP_EXCHANGES || 6);

/** Below this there is nothing worth assembling; the window is the context. */
const MIN_EXCHANGES_TO_TRIM = KEEP_EXCHANGES + 2;

/**
 * A single tool result outside the current turn, past this many characters,
 * is stubbed rather than carried.
 *
 * Ported from Sisyphean's `memory/compact.py`, mechanically — no model call.
 * It is the piece the exchange-boundary trim above does not cover: a `read`
 * that returns 32KB sits inside the *kept* verbatim window like anything
 * else, because from this file's point of view it is indistinguishable from
 * a short one. That is not hypothetical — it is what put 18,887 input tokens
 * into a single request from one oversized result still sitting in the
 * window several turns after it was read. 800 matches Sisyphean's own
 * figure, arrived at for the same reason: large content has already done its
 * job by the time a later turn is being assembled — the model read it, acted
 * on it, and moved on. Carrying it again is not fidelity, it is repetition.
 */
const MAX_TOOL_RESULT_CHARS = Number(process.env.CONTEXT_MAX_TOOL_RESULT_CHARS || 800);

/**
 * The hard ceiling this file is actually for.
 *
 * Everything above is a heuristic aimed at staying comfortably under this;
 * this is what enforces it when the heuristics are not enough on their own —
 * a conversation with one exchange and one enormous result would sail past
 * every check above, since neither the exchange-count trim nor the per-result
 * clamp look at the *total*. Chosen to match this model's own output budget
 * (`maxTokens: 8192` in models.json) rather than the 65536 context window:
 * the model that produced the sqrt(144) loop spent its entire output budget
 * reasoning about a 116-token input, so headroom in the context window was
 * never the constraint — what it is given to read, and what it has left to
 * answer with, both matter more than how much more the window could hold.
 *
 * A rough chars÷4 count, not a real tokenizer — the same estimator both
 * ported POCs use (BirdClaw's `estimate_tokens`, Sisyphean's `_estimate_tokens`),
 * for the same reason: a real count needs the model's own tokenizer, which
 * differs per provider and is not worth a dependency for a number this file
 * only uses as a threshold, not a bill.
 */
const MAX_CONTEXT_TOKENS = Number(process.env.CONTEXT_MAX_TOKENS || 8000);
const CHARS_PER_TOKEN = 4;

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

const isMessage = (m: unknown): m is ChatMessage =>
  typeof m === "object" && m !== null && typeof (m as ChatMessage).role === "string";

/** True when this looks like a chat-completions body we understand. */
function messagesOf(payload: unknown): ChatMessage[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.every(isMessage) ? (messages as ChatMessage[]) : undefined;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as any).text ?? "") : ""))
      .join(" ");
  }
  return "";
};

/**
 * Stub any tool result outside the newest turn that is over budget.
 *
 * The newest turn — from the last `user` message to the end — is never
 * touched, mirroring the exchange trim's own rule: a turn still being acted
 * on needs what it actually returned, not a note that something was there.
 * Everything before that boundary has already been read and answered from;
 * what is carried forward is that it happened; not its full weight.
 */
function clampToolResults(
  messages: ChatMessage[],
): { messages: ChatMessage[]; clamped: number } {
  let newestTurnStart = 0;
  messages.forEach((m, i) => {
    if (m.role === "user") newestTurnStart = i;
  });

  let clamped = 0;
  const out = messages.map((m, i) => {
    if (i >= newestTurnStart || m.role !== "tool") return m;
    const text = textOf(m.content);
    if (text.length <= MAX_TOOL_RESULT_CHARS) return m;
    clamped++;
    return {
      ...m,
      content: `[tool result compacted — was ${text.length} chars, already read and acted on in an earlier turn]`,
    };
  });
  return { messages: out, clamped };
}

/** Rough size of an assembled request: every message's own text, summed. */
function estimatedRequestTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(textOf(m.content)), 0);
}

export function contextAssembler(sessionId: string | undefined, sessionDate = () => new Date()) {
  return (pi: any): void => {
    pi.on("before_provider_request", async (event: any) => {
      const payload = event?.payload;
      const messages = messagesOf(payload);
      if (!messages) return undefined;

      // Leading system messages belong to the prompt, not the conversation.
      let head = 0;
      while (head < messages.length && messages[head].role === "system") head++;
      const system = messages.slice(0, head);

      /**
       * Every request, not only once the exchange count crosses a threshold.
       *
       * The trim below is gated on conversation length because a short
       * conversation is exactly its working set — nothing to point at memory
       * instead of showing. Clamping is a different question: whether any one
       * result, anywhere before the current turn, is bigger than carrying it
       * again is worth. That can be true on the very first follow-up message,
       * so it does not wait for the same gate.
       */
      const { messages: conversation, clamped } = clampToolResults(messages.slice(head));

      const userAt: number[] = [];
      conversation.forEach((m, i) => {
        if (m.role === "user") userAt.push(i);
      });

      /**
       * How many trailing exchanges to keep, and the ceiling's veto over it.
       *
       * Starts at the generous default — or, for a conversation too short for
       * the exchange trim to apply at all, at "everything" — and is pulled in
       * one exchange at a time only if the assembled request is still over
       * `MAX_CONTEXT_TOKENS` after clamping. The two mechanisms answer
       * different questions and neither substitutes for the other: clamping
       * catches the one oversized result sitting in an otherwise-fine window;
       * this catches a conversation whose *total* is too big even with every
       * individual result already reasonable.
       */
      let keepN = userAt.length >= MIN_EXCHANGES_TO_TRIM ? KEEP_EXCHANGES : userAt.length;

      const assemble = async (
        n: number,
      ): Promise<{ messages: ChatMessage[]; tokens: number }> => {
        if (n >= userAt.length) {
          const withSystem = [...system, ...conversation];
          return { messages: withSystem, tokens: estimatedRequestTokens(withSystem) };
        }

        const cut = userAt[userAt.length - n];
        const dropped = conversation.slice(0, cut);
        const kept = conversation.slice(cut);

        /**
         * What replaces the dropped exchanges.
         *
         * The conversation node harvest.ts maintains already holds a rolling
         * summary of this session, so the pointer is real rather than a
         * placeholder — and it names the node, which the model can search.
         * Falls back to a plain count when the harvest has not run yet,
         * because saying "there was more, and it is in memory" is still true
         * and still better than silently dropping it.
         */
        const nodeName = sessionId
          ? `conversation:${sessionDate().toISOString().slice(0, 10)}:${sessionId}`
          : undefined;
        let recalled = "";
        if (nodeName) {
          try {
            const node = await getNode(nodeName);
            if (node?.summary) recalled = node.summary;
          } catch {
            /* memory being unavailable must not break the request */
          }
        }

        const firstAsked = textOf(dropped.find((m) => m.role === "user")?.content).slice(0, 160);
        const note = [
          "",
          "# EARLIER IN THIS CONVERSATION",
          "",
          `${dropped.length} earlier message(s) are not shown here. They have not been lost — they are`,
          "in your memory, and the section above holds whatever of them was relevant to what",
          "was just asked. This is how you work: you assemble what you need rather than",
          "carrying everything.",
          firstAsked ? `\nIt began: "${firstAsked}"` : "",
          recalled ? `\nWhat you have recorded of it:\n${recalled}` : "",
          nodeName ? `\nSearch your memory for "${nodeName}" if you need more of it.` : "",
        ]
          .filter(Boolean)
          .join("\n");

        // Appended to the system prompt rather than inserted as a message of
        // its own: a synthetic turn in the middle of a conversation reads as
        // something somebody said, and this is not that. It also keeps the
        // message array in the conventional shape every provider expects.
        const withNote = system.length
          ? [
              { ...system[0], content: `${textOf(system[0].content)}\n${note}` },
              ...system.slice(1),
            ]
          : [{ role: "system", content: note }];

        const out = [...withNote, ...kept];
        return { messages: out, tokens: estimatedRequestTokens(out) };
      };

      let result = await assemble(keepN);
      /**
       * The ceiling wins over the generous default, one exchange at a time.
       *
       * Never below 1: the newest turn is never touched, by the same rule
       * `clampToolResults` follows — cutting inside it is a hard provider
       * error, not a degraded answer, so keeping it whole is the floor this
       * loop cannot go under. A single turn that is itself over budget is
       * accepted rather than broken.
       */
      while (result.tokens > MAX_CONTEXT_TOKENS && keepN > 1) {
        keepN -= 1;
        result = await assemble(keepN);
      }

      // Nothing to change: no result was clamped, and nothing was dropped.
      if (!clamped && keepN >= userAt.length) return undefined;

      return { ...(payload as object), messages: result.messages };
    });
  };
}
