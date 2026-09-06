import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTasks, listTasks, setTasks, setTaskStatus, type TaskRow } from "../db.js";

/**
 * Writing a long document or program one piece at a time.
 *
 * Ports Sisyphean's write-plan pipeline (`core/pipeline.py`'s
 * `_start_write_plan` / `_write_plan_next_item`), and it is worth being clear
 * about why, because most of Sisyphean's staging exists to get structure out of
 * a 0.6B model and this does not.
 *
 * A long document written in one call has three problems no model size fixes:
 *
 *   - **Attention thins out.** The last section of a ten-section document is
 *     written with the first nine in context and the least budget remaining.
 *     Section by section, each gets the same attention as the first.
 *   - **Failure costs everything.** A call that dies at 80% leaves nothing.
 *     Incrementally, the file on disk *is* the state, and an interruption costs
 *     one section.
 *   - **It cannot be resumed.** "Carry on where you left off" needs somewhere
 *     to have left off. The file is that.
 *
 * The difference from Sisyphean is who drives. There, the pipeline marched the
 * model through stages because it could not be trusted to keep a plan. Here
 * these are tools: the model decides when a piece is done and asks for the
 * next, which is what a model that can follow a plan should be allowed to do.
 * The portal keeps the plan, the file and the position.
 *
 * The plan lives in the same `tasks` table `task_plan` uses. One notion of "the
 * steps I am working through" rather than two — a section of a document is a
 * step, and giving it its own store would mean two answers to what the session
 * is doing.
 */

/** Long enough that a section is worth its own turn; short enough not to nag. */
const MIN_SECTION_CHARS = 200;

const said = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** Where the current document lives, per session. */
const documents = new Map<string, string>();

/**
 * What is already written, so the next section follows from it.
 *
 * The tail rather than the whole file: what a section needs is what immediately
 * precedes it, and handing back a novel to write its last chapter is the
 * problem this exists to avoid.
 */
function tail(file: string, chars = 2000): string {
  if (!existsSync(file)) return "";
  try {
    const text = readFileSync(file, "utf8");
    return text.length <= chars ? text : `…\n${text.slice(-chars)}`;
  } catch {
    return "";
  }
}

export function writingTools(sessionId: string | undefined, cwd: string) {
  return (pi: any): void => {
    if (!sessionId) return;

    pi.registerTool({
      name: "write_plan",
      label: "Plan a document",
      description:
        "Plan a long document or program before writing it, then write it one section at a time " +
        "with write_next. Use this for anything substantial — an essay, a report, a module with " +
        "several functions — rather than composing the whole thing in one reply: each section gets " +
        "your full attention, the file on disk is the state, and an interruption costs one section " +
        "instead of everything. For something short, just use write.",
      promptSnippet: "write_plan — plan a long document, then write it section by section",
      parameters: Type.Object({
        file: Type.String({ description: "Path to write to. Created if it does not exist." }),
        sections: Type.Array(Type.String(), {
          description: "Section headings or function names, in the order they should be written.",
        }),
        overwrite: Type.Optional(
          Type.Boolean({ description: "Start the file fresh. Default false — appends to what is there." }),
        ),
      }),
      async execute(_id: string, p: any) {
        const file = String(p?.file ?? "").trim();
        const sections = (Array.isArray(p?.sections) ? p.sections : [])
          .map((s: unknown) => String(s ?? "").trim())
          .filter(Boolean);
        if (!file) return said("No file given.");
        if (!sections.length) return said("No sections given — nothing to plan.");

        /**
         * Resolved against the *session's* workspace, not the server's cwd.
         *
         * A model asked to write "guide.md" gives exactly that, and
         * `path.resolve` on a relative path uses `process.cwd()` — which is
         * wherever the portal was started. The first live test wrote the file
         * into the Phoenixclaw checkout instead of the workspace, reported
         * success, and left the agent unable to find what it had just written.
         */
        const target = path.isAbsolute(file) ? file : path.join(cwd, file);
        mkdirSync(path.dirname(target), { recursive: true });
        if (p?.overwrite === true || !existsSync(target)) writeFileSync(target, "", "utf8");

        documents.set(sessionId, target);
        // Replaces the session's plan: writing a document *is* what this
        // session is doing, and two plans would be two answers to that.
        await clearTasks(sessionId);
        await setTasks(sessionId, sections);

        return said(
          `Planned ${sections.length} section(s) of ${target}:\n` +
            sections.map((s: string, i: number) => `  ${i + 1}. ${s}`).join("\n") +
            `\n\nWrite the first with write_next. One section per call.`,
        );
      },
    });

    pi.registerTool({
      name: "write_next",
      label: "Write the next section",
      description:
        "Append the next section of the planned document. You are given what is already written so " +
        "this one follows from it — match its voice and do not repeat what is above. Write this " +
        "section only: the plan remembers the rest, and stopping here is the point. Call it again " +
        "for the next one.",
      promptSnippet: "write_next — append the next planned section",
      parameters: Type.Object({
        content: Type.String({ description: "The section's full text, ready to append." }),
      }),
      async execute(_id: string, p: any) {
        const file = documents.get(sessionId);
        if (!file) return said("No document in progress. Start one with write_plan.");

        const pending = (await listTasks(sessionId)).find((t: TaskRow) => t.status === "pending");
        if (!pending) return said("Every planned section is written. The document is finished.");

        const content = String(p?.content ?? "").trimEnd();
        if (content.length < MIN_SECTION_CHARS) {
          // Refused rather than accepted: a section written in one line is the
          // failure this tool exists to prevent, and silently taking it would
          // produce a document that looks planned and reads like an outline.
          return said(
            `That is ${content.length} characters — too short for "${pending.description}". ` +
              `Write the section properly, at least ${MIN_SECTION_CHARS} characters. If it genuinely ` +
              `needs nothing, use write_skip with a reason.`,
          );
        }

        const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
        appendFileSync(file, `${existing && !existing.endsWith("\n\n") ? "\n\n" : ""}${content}\n`, "utf8");
        await setTaskStatus(sessionId, pending.seq, "done", `${content.length} chars`);

        const left = (await listTasks(sessionId)).filter((t: TaskRow) => t.status === "pending");
        if (!left.length) {
          documents.delete(sessionId);
          return said(`Wrote "${pending.description}". The document is complete: ${file}`);
        }

        return said(
          `Wrote "${pending.description}" (${content.length} chars).\n\n` +
            `Next: "${left[0].description}". What is already there ends with:\n\n${tail(file, 600)}`,
        );
      },
    });

    pi.registerTool({
      name: "write_skip",
      label: "Skip a planned section",
      description:
        "Skip the next planned section, saying why. Use it when the plan turned out to be wrong — a " +
        "section that duplicates another, or that the material does not support. Better than writing " +
        "something thin to satisfy the plan.",
      promptSnippet: "write_skip — drop a planned section that turned out unnecessary",
      parameters: Type.Object({
        why: Type.String({ description: "Why this section is not needed." }),
      }),
      async execute(_id: string, p: any) {
        const pending = (await listTasks(sessionId)).find((t: TaskRow) => t.status === "pending");
        if (!pending) return said("Nothing left to skip.");
        await setTaskStatus(sessionId, pending.seq, "failed", String(p?.why ?? "skipped").slice(0, 300));
        const left = (await listTasks(sessionId)).filter((t: TaskRow) => t.status === "pending");
        return said(
          left.length
            ? `Skipped "${pending.description}". Next: "${left[0].description}".`
            : `Skipped "${pending.description}". Nothing left — the document is finished.`,
        );
      },
    });
  };
}
