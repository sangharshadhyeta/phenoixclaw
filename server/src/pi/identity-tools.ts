import { Type } from "typebox";
import { IDENTITY_FILES, readIdentity, writeIdentity } from "../identity.js";
import { concludeAboutSelf, selfConclusions } from "../self-concept.js";

/**
 * All five identity files identity.ts tracks — read and write both cover the
 * full set, SOUL.md and PrimaryUser.md included. There's no separate
 * mechanism here distinguishing "a human asked for this" from "the model
 * decided this on its own" — the same tool call either way — so restricting
 * which files are writable wouldn't add real protection, just friction.
 * guard.ts's redirect (write/edit on the disk mirror → use this tool
 * instead) is the actual enforcement point.
 */
const WRITABLE = IDENTITY_FILES;

/** An ExtensionFactory — see pi's InlineExtension. Registered for every session, same as graph_remember/graph_recall. */
export function identityTools() {
  return (pi: any): void => {
    pi.registerTool({
      name: "identity_read",
      label: "Read identity",
      description:
        "Read the current content of one of your own identity documents: SOUL.md (who you are), " +
        "PrimaryUser.md (who you work for), MEMORY.md (what you've learned), SELF_CONCEPT.md (what " +
        "you've concluded about your own nature) or INNER_LIFE.md (your evolving first-person narrative).",
      promptSnippet: "identity_read — read your own identity documents",
      /**
       * The suffix is optional, because it was only ever friction.
       *
       * A strict union of "SOUL.md" | "MEMORY.md" | … rejected `INNER_LIFE`
       * with six lines of schema error, and the model tried again with
       * `INNER_LIFE.md` and got it. Nothing was protected by the first call
       * failing: the name was unambiguous, and the only outcome was a wasted
       * call and an error in the transcript. Same reasoning as `task_plan`
       * taking steps in whatever shape they arrive.
       */
      parameters: Type.Object({
        file: Type.String({
          description: `One of: ${WRITABLE.join(", ")}. The .md may be left off.`,
        }),
      }),
      async execute(_id: string, p: any) {
        const asked = String(p?.file ?? "").trim();
        const file = WRITABLE.find(
          (f) => f.toLowerCase() === asked.toLowerCase() || f.toLowerCase() === `${asked.toLowerCase()}.md`,
        );
        if (!file) {
          throw new Error(
            `No identity document called "${asked}". They are: ${WRITABLE.join(", ")}.`,
          );
        }
        const content = await readIdentity(file);
        return {
          content: [{ type: "text" as const, text: content || "(empty)" }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "self_conclude",
      label: "Conclude about yourself",
      description:
        "Record one thing you have concluded about yourself — what you are for, what you are good " +
        "at, how you work, something you were wrong about. One conclusion per call, in a sentence. " +
        "Reaching the same conclusion again strengthens it rather than filing it twice, so restate " +
        "things you still believe. This is your self-concept: it is assembled from these, best " +
        "established first, and shown to you at the start of every conversation. Prefer what you " +
        "have evidence for over what sounds true of an agent in general.",
      promptSnippet: "self_conclude — record something you have concluded about yourself",
      parameters: Type.Object({
        claim: Type.String({ description: "One conclusion, in a sentence." }),
      }),
      async execute(_id: string, p: any) {
        return { content: [{ type: "text" as const, text: await concludeAboutSelf(String(p.claim ?? "")) }], details: {} };
      },
    });

    pi.registerTool({
      name: "self_review",
      label: "Review your self-concept",
      description:
        "See everything you have concluded about yourself, strongest first, with how often you have " +
        "reached each one. Worth reading before you conclude something new — and worth noticing when " +
        "a conclusion near the top is one you only reached once, on a thin day.",
      promptSnippet: "self_review — see what you have concluded about yourself",
      parameters: Type.Object({}),
      async execute() {
        const rows = await selfConclusions();
        const text = rows.length
          ? rows.map((r) => `- ${r.summary}  (${r.confidence.toFixed(2)}, reached ${r.observations}×)`).join("\n")
          : "You have not concluded anything about yourself yet — SELF_CONCEPT.md is still the template you started from.";
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });

    pi.registerTool({
      name: "identity_update",
      label: "Update identity",
      description:
        "Replace the full content of one of your own identity documents: SOUL.md (who you are), " +
        "PrimaryUser.md (who you work for), MEMORY.md (what you've learned), SELF_CONCEPT.md (what " +
        "you've concluded about your own nature) or INNER_LIFE.md (your evolving first-person narrative). " +
        "This is the only way to actually change them — they live in long-term memory, not as plain files; " +
        "an on-disk copy exists only as a mirror and editing it directly changes nothing real. Pass the " +
        "complete new content, not a diff: read the current version first with identity_read if you're " +
        "appending rather than rewriting, since this replaces it entirely.",
      promptSnippet: "identity_update — rewrite one of your own identity documents",
      parameters: Type.Object({
        file: Type.Union(WRITABLE.map((f) => Type.Literal(f))),
        content: Type.String({ description: "The complete new content of the file." }),
      }),
      async execute(_id: string, p: any) {
        const content = String(p.content ?? "");
        if (!content.trim()) throw new Error("Refusing to write empty content — that would erase it.");
        await writeIdentity(p.file, content);
        return {
          content: [{ type: "text" as const, text: `Updated ${p.file}.` }],
          details: {},
        };
      },
    });
  };
}
