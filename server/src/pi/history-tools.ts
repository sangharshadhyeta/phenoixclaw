import { Type } from "typebox";
import { eventsSince, searchTranscripts, searchableSessionIds } from "../db.js";

/**
 * Read back this conversation's own earlier turns.
 *
 * The counterpart to context-assembler.ts. Assembling context rather than
 * accumulating it means older exchanges leave the prompt — which is the point,
 * and which would be a loss if they were simply gone. They are not: the event
 * log holds every turn verbatim. This is how the agent reaches them.
 *
 * It exists because the graph is not always enough, and the way it fails is
 * quiet. A conversation recorded "my favourite colour is vermilion"; the next
 * question asked for "my favorite colour". Keyword search is exact on tokens,
 * the spellings differ by one letter, and semantic search — which would have
 * matched them — was unavailable. Nothing was wrong with the memory. The agent
 * simply could not find it, and answered that it did not know.
 *
 * A verbatim search over what was actually said has no such gap: it is the
 * same text the person typed, and `contains` is a plain substring match rather
 * than a tokenised one, so a partial word still finds it.
 *
 * Reading is scoped to the session's own history. There is no parameter for
 * another session's id — cross-conversation recall goes through the graph,
 * which is where the role boundaries are enforced. This tool cannot be aimed
 * at somebody else's chat.
 */

/** Enough to answer "what did we say", small enough not to undo the assembly. */
const DEFAULT_TURNS = 8;
const MAX_TURNS = 40;
const MAX_CHARS = 6000;

interface Exchange {
  asked?: string;
  said: string[];
}

/** Rebuild exchanges from the event log, in order. */
async function exchanges(sessionId: string): Promise<Exchange[]> {
  const rows = await eventsSince(sessionId, 0, 1_000_000);
  const out: Exchange[] = [];
  let current: Exchange | undefined;
  let buffer = "";

  const flush = () => {
    const done = buffer.trim();
    buffer = "";
    if (done && current) current.said.push(done);
  };

  for (const row of rows) {
    let payload: any;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (row.type === "portal_prompt") {
      flush();
      current = { asked: String(payload?.message ?? "").trim(), said: [] };
      out.push(current);
    } else if (row.type === "message_update") {
      const inner = payload?.assistantMessageEvent ?? {};
      if (inner.type === "text_delta" && typeof inner.delta === "string") buffer += inner.delta;
    } else if (row.type === "message_end") {
      flush();
    }
  }
  flush();
  return out.filter((e) => e.asked || e.said.length);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function historyTools(sessionId: string | undefined, role?: string) {
  return (pi: any): void => {
    if (!sessionId) return;

    pi.registerTool({
      name: "conversation_history",
      label: "Read earlier in this conversation",
      description:
        "Read back what was actually said earlier in this same conversation, word for word. " +
        "Older exchanges are not kept in your context — you are given what is relevant rather " +
        "than everything — so use this when you need the earlier wording itself: what someone " +
        "asked for exactly, a name or number mentioned before, or what you already told them. " +
        "Prefer it over guessing, and over saying you do not know. `contains` filters to turns " +
        "containing that text and is matched literally, so a partial word works and spelling " +
        "does not have to match your memory of it.",
      promptSnippet: "conversation_history — read earlier turns of this conversation verbatim",
      parameters: Type.Object({
        contains: Type.Optional(
          Type.String({ description: "Only turns containing this text, matched literally." }),
        ),
        turns: Type.Optional(
          Type.Number({ description: `How many recent turns to read. Default ${DEFAULT_TURNS}.` }),
        ),
      }),
      async execute(_id: string, p: any) {
        const all = await exchanges(sessionId);
        const needle = typeof p?.contains === "string" ? p.contains.trim().toLowerCase() : "";
        const matched = needle
          ? all.filter((e) => `${e.asked ?? ""} ${e.said.join(" ")}`.toLowerCase().includes(needle))
          : all;

        const want = Math.min(Math.max(Number(p?.turns) || DEFAULT_TURNS, 1), MAX_TURNS);
        // The most recent matches, but rendered oldest-first so the exchange
        // still reads forwards.
        const chosen = matched.slice(-want);

        if (!chosen.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: needle
                  ? `Nothing earlier in this conversation contains "${p.contains}".`
                  : "This conversation has no earlier turns.",
              },
            ],
            details: {},
          };
        }

        let text = chosen
          .map((e) => {
            const asked = e.asked ? `They said: ${squash(e.asked)}` : "";
            const said = e.said.length ? `You said: ${squash(e.said.join(" "))}` : "";
            return [asked, said].filter(Boolean).join("\n");
          })
          .join("\n\n");
        if (text.length > MAX_CHARS) text = `…${text.slice(-MAX_CHARS)}`;

        const header = needle
          ? `${chosen.length} earlier turn(s) containing "${p.contains}":`
          : `The last ${chosen.length} turn(s) of this conversation:`;
        return { content: [{ type: "text" as const, text: `${header}\n\n${text}` }], details: {} };
      },
    });

    /**
     * The same verbatim search, across every conversation rather than this one.
     *
     * The graph is the right instrument for "what do I know about X"; it is the
     * wrong one for "what did they actually say", because it stores a bounded
     * rewrite. The failure that made this necessary was not subtle: a
     * conversation recorded "my favourite colour is vermilion", the next asked
     * about "my favorite colour", keyword search is exact on tokens, semantic
     * search was unavailable, and the agent answered that it did not know. One
     * letter.
     *
     * Primary-role only, and scoped to conversations that also served the
     * primary user. Somebody else's chat is not this session's to read, and the
     * graph — where the role boundary is already enforced per node type — stays
     * the route for anything cross-person.
     */
    if (!role || role === "primary") {
      pi.registerTool({
        name: "search_conversations",
        label: "Search past conversations",
        description:
          "Search word-for-word across your past conversations with this person, including ones " +
          "long finished. Use it when they refer to something said before and your memory search " +
          "did not find it — memory holds a rewritten summary, this holds what was actually typed, " +
          "so it catches exact names, numbers, and spellings that differ from how you remember " +
          "them. Matched literally, so a partial word works.",
        promptSnippet: "search_conversations — find what was actually said, across conversations",
        parameters: Type.Object({
          contains: Type.String({ description: "Text to find. Matched literally, not by keyword." }),
          limit: Type.Optional(Type.Number({ description: "Most matches to return. Default 12." })),
        }),
        async execute(_id: string, p: any) {
          const needle = String(p?.contains ?? "").trim();
          if (!needle) return { content: [{ type: "text" as const, text: "Nothing to search for." }], details: {} };

          const rows = await searchTranscripts(needle, {
            sessionIds: await searchableSessionIds(),
            limit: Math.min(Math.max(Number(p?.limit) || 12, 1), 40),
          });
          if (!rows.length) {
            return {
              content: [{ type: "text" as const, text: `Nothing in any conversation contains "${needle}".` }],
              details: {},
            };
          }

          const lines = rows.map((r) => {
            let said = "";
            try {
              const payload = JSON.parse(r.payload);
              said =
                r.type === "portal_prompt"
                  ? `They said: ${squash(String(payload?.message ?? ""))}`
                  : `You said: ${squash(String(payload?.assistantMessageEvent?.delta ?? ""))}`;
            } catch {
              return "";
            }
            const on = String(r.created_at).slice(0, 16).replace("T", " ");
            return said.length > 12 ? `- [${on}, in "${r.title}"] ${said.slice(0, 300)}` : "";
          });

          const text = lines.filter(Boolean).join("\n").slice(0, MAX_CHARS);
          return {
            content: [
              {
                type: "text" as const,
                text: text
                  ? `Found "${needle}" in earlier conversations:\n\n${text}`
                  : `Nothing readable in any conversation contains "${needle}".`,
              },
            ],
            details: {},
          };
        },
      });
    }
  };
}
