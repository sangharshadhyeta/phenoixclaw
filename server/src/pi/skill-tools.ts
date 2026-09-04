import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { piAgentDir } from "../pi-settings.js";
import { recordAudit } from "../db.js";

/**
 * Writing a skill, without writing a file.
 *
 * The Dream Cycle's skill-synthesis phase needs to put a SKILL.md on disk, and
 * an autonomous turn has no `write` tool — deliberately. Raw `write` would
 * make the constitution's allowlist decorative: pi discovers extensions in
 * `agentDir/extensions/` and `cwd/.pi/extensions/`, loads them as JavaScript,
 * and under the host executor runs them in the portal's own process. One file
 * there and the next session has whatever tools the agent wrote for itself,
 * the guard included. `mcp.json` in the same directory registers arbitrary
 * external tools, and `/data/bin` is on PATH.
 *
 * So this is the shape the security guide already argues for ("an allowlist
 * beats a blocklist... a session that only needs to read email should have
 * tools shaped like reading email, not `bash`"): a tool that can produce
 * exactly one kind of artefact, in exactly one place.
 *
 * What it constrains, and why each one:
 *
 * - The name is a slug, and the path is composed here rather than taken. A
 *   caller never supplies a path, so there is nothing to traverse out of; the
 *   resolved result is re-checked against the root anyway, because "cannot
 *   happen" is the wrong thing to rely on for a directory whose contents are
 *   executed by something.
 * - The frontmatter is generated from `name` and `description`, not parsed
 *   out of submitted text. A skill whose frontmatter is malformed is a skill
 *   that silently never loads, and this is written by something nobody is
 *   watching.
 * - It writes SKILL.md and nothing else. Not `.js`, not `package.json` — the
 *   two files that would turn a skills directory into an extensions
 *   directory.
 * - It will not overwrite a skill it did not write. Refining its own earlier
 *   conclusion is the point; quietly rewriting one a human wrote, or one the
 *   portal ships, is not.
 */

/** Stamped into every generated skill: the provenance marker, and the overwrite check. */
const MARK = "<!-- written by the agent's self-reflection cycle, unattended -->";

const skillsRoot = (): string => {
  const dir = path.join(piAgentDir(), "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Lowercase, hyphens, no dots or separators — the same shape frontmatter's `name` requires. */
const VALID_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** An ExtensionFactory — see pi's InlineExtension. Registered for autonomous sessions only. */
export function skillTools(sessionId?: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "skill_write",
      label: "Write skill",
      description:
        "Record a reusable procedure as a skill, so a future session can find and follow it. Use this " +
        "when you notice a pattern worth repeating — the steps you would take again, written down for " +
        "next time. The description is what decides whether the skill is ever used: write a trigger " +
        "(\"Use when the user asks to...\"), not a title. Writing a name that already exists replaces " +
        "your own earlier version of that skill; it will not overwrite one written by a person.",
      promptSnippet: "skill_write — record a reusable procedure as a skill",
      parameters: Type.Object({
        name: Type.String({
          description: "Lowercase name, hyphens instead of spaces, e.g. 'cut-a-release'. This is what /skill:<name> uses.",
        }),
        description: Type.String({
          description: "When to use this skill. A trigger, not a title — this is what decides whether it is ever chosen.",
        }),
        body: Type.String({
          description: "The skill itself, in Markdown: the procedure, in the order it should be done.",
        }),
      }),
      async execute(_id: string, p: any) {
        const name = String(p.name ?? "").trim().toLowerCase();
        if (!VALID_NAME.test(name)) {
          throw new Error(
            `"${name}" is not a usable skill name. Use lowercase letters, digits and hyphens, 2-64 characters.`,
          );
        }
        const description = String(p.description ?? "").trim();
        if (!description) throw new Error("A skill needs a description saying when to use it.");
        const body = String(p.body ?? "").trim();
        if (!body) throw new Error("A skill with no body is not worth writing.");

        const root = skillsRoot();
        const file = path.join(root, name, "SKILL.md");
        // Composed, never supplied — but resolved and re-checked regardless,
        // because this directory's contents are read as instructions later.
        const resolved = path.resolve(file);
        if (resolved !== file || !resolved.startsWith(root + path.sep)) {
          throw new Error("Refusing to write outside the skills directory.");
        }

        if (existsSync(resolved)) {
          let existing = "";
          try {
            existing = readFileSync(resolved, "utf8");
          } catch {
            // Unreadable is not "mine": fall through to the refusal below.
          }
          if (!existing.includes(MARK)) {
            throw new Error(
              `A skill called "${name}" already exists and was not written by you. Pick a different ` +
                `name — do not replace someone else's work.`,
            );
          }
        }

        // Quoted: a colon in a description is the single most common way a
        // skill's frontmatter stops parsing, and this one is not proofread by
        // anybody before it loads.
        const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        const content =
          `---\nname: ${quote(name)}\ndescription: ${quote(description)}\n---\n\n` +
          `${MARK}\n\n${body}\n`;

        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, "utf8");
        await recordAudit({
          kind: "skill-written",
          tool: "skill_write",
          subject: name,
          reason: description.slice(0, 200),
          sessionId: sessionId ?? null,
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Wrote the skill "${name}". It loads for every session from now on, so it is worth ` +
                `being sure the description says when it applies.`,
            },
          ],
          details: {},
        };
      },
    });
  };
}
