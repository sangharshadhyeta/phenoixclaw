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
 * which costs far more than the tokens saved. Trimming starts only past this.
 */
const KEEP_EXCHANGES = Number(process.env.CONTEXT_KEEP_EXCHANGES || 6);

/** Below this there is nothing worth assembling; the window is the context. */
const MIN_EXCHANGES_TO_TRIM = KEEP_EXCHANGES + 2;

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
      const conversation = messages.slice(head);

      const userAt: number[] = [];
      conversation.forEach((m, i) => {
        if (m.role === "user") userAt.push(i);
      });
      if (userAt.length < MIN_EXCHANGES_TO_TRIM) return undefined;

      // Cut at a user boundary so no turn is ever split from its tool results.
      const cut = userAt[userAt.length - KEEP_EXCHANGES];
      if (cut === undefined || cut <= 0) return undefined;

      const dropped = conversation.slice(0, cut);
      const kept = conversation.slice(cut);

      /**
       * What replaces the dropped exchanges.
       *
       * The conversation node harvest.ts maintains already holds a rolling
       * summary of this session, so the pointer is real rather than a
       * placeholder — and it names the node, which the model can search.
       * Falls back to a plain count when the harvest has not run yet, because
       * saying "there was more, and it is in memory" is still true and still
       * better than silently dropping it.
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

      // Appended to the system prompt rather than inserted as a message of its
      // own: a synthetic turn in the middle of a conversation reads as
      // something somebody said, and this is not that. It also keeps the
      // message array in the conventional shape every provider expects.
      const withNote = system.length
        ? [
            { ...system[0], content: `${textOf(system[0].content)}\n${note}` },
            ...system.slice(1),
          ]
        : [{ role: "system", content: note }];

      return { ...(payload as object), messages: [...withNote, ...kept] };
    });
  };
}
