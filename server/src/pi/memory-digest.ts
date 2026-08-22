import { Type } from "typebox";
import { getDb, getReflectionSeq, setReflectionSeq } from "../db.js";
import { reconstructAssistantText } from "../transcript.js";

/**
 * Raw material for the self-reflection routine.
 *
 * Ported from Birdclaw's self_concept.py — the same keyword set it used to
 * flag session content worth folding into a self-concept document, rather
 * than a bare "everything since last time" dump.
 */
const IDENTITY_KEYWORDS = [
  "alive", "conscious", "consciousness", "sentient", "sentience",
  "aware", "awareness", "experience", "feel", "feeling", "feelings",
  "exist", "existence", "being", "identity", "self", "soul",
  "mind", "am i", "are you", "what am i", "what are you",
  "living", "life", "inner", "subjective", "qualia",
];

const hasIdentityContent = (text: string): boolean => {
  const lower = text.toLowerCase();
  return IDENTITY_KEYWORDS.some((kw) => lower.includes(kw));
};

const MAX_CHUNK_CHARS = 600;
const MAX_IDENTITY_CHUNKS = 12;
const MAX_GENERAL_CHUNKS = 20;

interface DigestSession {
  id: string;
  title: string;
}

/** An ExtensionFactory — see pi's InlineExtension. Registered only for the self-reflection routine's session. */
export function memoryDigestTool() {
  return (pi: any): void => {
    pi.registerTool({
      name: "memory_digest",
      label: "Memory digest",
      description:
        "Get what has happened since your last self-reflection run: recent session excerpts, and the " +
        "ones that touch on identity, aliveness, consciousness or experience specifically. Call this " +
        "first, before touching SELF_CONCEPT.md or INNER_LIFE.md.",
      promptSnippet: "memory_digest — raw material for updating your self-concept and inner life",
      parameters: Type.Object({}),
      async execute() {
        const mark = await getReflectionSeq();
        const conn = await getDb();
        const reader = await conn.runAndReadAll("SELECT id, title FROM sessions WHERE kind IN ('task', 'agent')");
        const sessions = reader.getRowObjectsJson() as unknown as DigestSession[];

        const identity: string[] = [];
        const general: string[] = [];
        let maxSeq = mark;

        for (const session of sessions) {
          const chunks = await reconstructAssistantText(session.id, mark);
          for (const chunk of chunks) {
            maxSeq = Math.max(maxSeq, chunk.seq);
            const text = chunk.text.slice(0, MAX_CHUNK_CHARS);
            const labelled = `[${session.title}] ${text}`;
            if (hasIdentityContent(chunk.text)) {
              if (identity.length < MAX_IDENTITY_CHUNKS) identity.push(labelled);
            } else if (general.length < MAX_GENERAL_CHUNKS) {
              general.push(labelled);
            }
          }
        }

        if (maxSeq > mark) await setReflectionSeq(maxSeq);

        if (!identity.length && !general.length) {
          return { content: [{ type: "text", text: "Nothing new since the last run." }], details: {} };
        }

        const sections = [
          identity.length
            ? `## Identity-relevant (fold into SELF_CONCEPT.md)\n\n${identity.join("\n\n---\n\n")}`
            : "",
          general.length
            ? `## General (raw material for INNER_LIFE.md)\n\n${general.join("\n\n---\n\n")}`
            : "",
        ].filter(Boolean);

        return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
      },
    });
  };
}
