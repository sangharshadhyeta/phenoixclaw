import { Type } from "typebox";
import { IDENTITY_FILES, readIdentity, writeIdentity } from "../identity.js";

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
      parameters: Type.Object({
        file: Type.Union(WRITABLE.map((f) => Type.Literal(f))),
      }),
      async execute(_id: string, p: any) {
        const content = await readIdentity(p.file);
        return {
          content: [{ type: "text" as const, text: content || "(empty)" }],
          details: {},
        };
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
