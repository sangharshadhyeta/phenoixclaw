import { Type } from "typebox";
import {
  artefactHistory,
  artefactPath,
  commitArtefact,
  projectSlug,
  isArtefact,
  readArtefactPlan,
  writeArtefactPlan,
} from "../artefacts.js";
import { priorWork } from "./prior-work.js";
import { selfContainmentNote } from "./step-text.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  clearTasks,
  eventsSince,
  getSession,
  listTasks,
  setTasks,
  setTaskStatus,
  updateSession,
  type TaskRow,
} from "../db.js";

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

/**
 * Where each written section actually sits in the file.
 *
 * The first version of this recorded only a length, which was enough to notice
 * that the file had shrunk and nothing else. It meant the only way back into
 * what had been written was `tail()` — a blind slice of the last N bytes,
 * usually starting mid-sentence — so a model that needed section three could
 * not have it, and a section that came out wrong could not be fixed. Append was
 * the only operation.
 *
 * Prose mostly survives that. Code does not: the point of writing a module
 * function by function is that you find out, at function seven, that function
 * three had the wrong signature. Without a range there is nothing to go back
 * to, and the model's only recourse is to rewrite the whole file with `write` —
 * which is both the thing this tool exists to avoid and the thing write_check's
 * shrink detector then reports as data loss.
 *
 * Stored in the task's `result`, which is where the plan already keeps what
 * came of a step. Offsets shift when an earlier section is revised, so
 * `write_revise` moves the later ones by the delta rather than leaving them
 * pointing at the wrong text.
 */
interface Span {
  start: number;
  end: number;
}

const spanOf = (result: string | null): Span | undefined => {
  const m = /@(\d+)-(\d+)$/.exec(String(result ?? ""));
  return m ? { start: Number(m[1]), end: Number(m[2]) } : undefined;
};

const spanResult = (span: Span): string => `${span.end - span.start} chars @${span.start}-${span.end}`;

/**
 * Is this file code, and if so what kind?
 *
 * It decides two things that genuinely differ between a report and a module:
 * what counts as a leftover stub, and whether the file can be *checked* rather
 * than merely measured. "TODO" in an essay is an unfinished essay; in code it
 * is often a deliberate note. `...` is an ellipsis in prose and a spread
 * operator in JavaScript — the stub scan used to report every `foo(...args)`
 * as an unfinished document.
 */
const LANGUAGES: Record<string, { check?: (file: string) => string | undefined }> = {
  ".js": { check: (f) => nodeCheck(f) },
  ".mjs": { check: (f) => nodeCheck(f) },
  ".cjs": { check: (f) => nodeCheck(f) },
  ".json": {
    check: (f) => {
      try {
        JSON.parse(readFileSync(f, "utf8"));
        return undefined;
      } catch (err) {
        return String((err as Error).message);
      }
    },
  },
  ".py": {
    check: (f) => {
      const out = spawnSync("python3", ["-m", "py_compile", f], { encoding: "utf8", timeout: 10_000 });
      return out.status === 0 ? undefined : (out.stderr || out.stdout || "").trim().slice(0, 400) || undefined;
    },
  },
  // No cheap syntax-only check for TypeScript — `tsc` wants the project. The
  // delimiter balance below still catches the failure that matters here, which
  // is a section that stopped halfway.
  ".ts": {},
  ".tsx": {},
  ".jsx": {},
  ".go": {},
  ".rs": {},
  ".c": {},
  ".h": {},
  ".cpp": {},
  ".java": {},
  ".rb": {},
  ".sh": {
    check: (f) => {
      const out = spawnSync("bash", ["-n", f], { encoding: "utf8", timeout: 10_000 });
      return out.status === 0 ? undefined : (out.stderr || "").trim().slice(0, 400) || undefined;
    },
  },
};

const languageOf = (file: string) => LANGUAGES[path.extname(file).toLowerCase()];

function nodeCheck(file: string): string | undefined {
  const out = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10_000 });
  return out.status === 0 ? undefined : (out.stderr || "").trim().split("\n").slice(0, 6).join("\n") || undefined;
}

/**
 * Unbalanced brackets, ignoring strings and comments.
 *
 * The universal symptom of a section that stopped halfway — which is exactly
 * what incremental writing risks and exactly what a length check cannot see.
 * Deliberately crude: it reports a count, not a position, and it is only ever
 * used as a warning in write_check.
 */
export function unbalanced(text: string): string | undefined {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const rest = text.slice(i, i + 3);
    if (c === "\"" || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (rest.startsWith("//") || c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (pairs[c]) {
      if (stack.pop() !== pairs[c]) return `A ${c} closes something that was never opened.`;
    }
    i++;
  }
  return stack.length ? `${stack.length} unclosed ${stack.map((x) => x).join("")} — a section probably stopped halfway.` : undefined;
}

const said = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const MARK: Record<string, string> = { pending: "·", running: "▸", done: "✓", failed: "✗" };
const render = (tasks: TaskRow[]): string =>
  tasks.map((t) => `${MARK[t.status] ?? "·"} [${t.seq}] ${t.description}`).join("\n");

/**
 * Has this session found anything out, or is it writing from memory?
 *
 * Sisyphean's decomposer had a rule this port dropped: "Research, analysis and
 * explanation tasks MUST have at least 2 steps", with `research` and
 * `write_doc` as separate step types. `write_plan` plans the *sections of the
 * output* and says nothing about the *work needed to produce it*, so a guide
 * about a factual subject was written straight from what the model already
 * believed, checking nothing.
 *
 * That is "verify, don't recall" failing at the point it matters most: a
 * document is the most confident-looking thing an agent produces and the
 * hardest to tell apart from a researched one.
 *
 * So the plan notices. It does not *refuse* — marching a capable model through
 * a research stage is the pipeline shape this port deliberately rejected, and
 * plenty of documents are legitimately written from what is already known. It
 * says what it sees, at the moment the model is deciding what to do, which is
 * the same thing the memory injector does for recall.
 */
const LOOKING = new Set([
  "web_search",
  "web_fetch",
  "read",
  "grep",
  "find",
  "graph_recall",
  "graph_ingest",
  "find_symbol",
  "conversation_history",
  "search_conversations",
  "map_project",
]);

async function hasLookedAnythingUp(sessionId: string): Promise<boolean> {
  try {
    const rows = await eventsSince(sessionId, 0, 5000);
    return rows.some((row) => {
      if (row.type !== "tool_execution_start") return false;
      try {
        return LOOKING.has(String(JSON.parse(row.payload)?.toolName ?? ""));
      } catch {
        return false;
      }
    });
  } catch {
    // If the log cannot be read, say nothing rather than nag wrongly.
    return true;
  }
}

/**
 * What is already written, so the next section follows from it.
 *
 * The tail rather than the whole file: what a section needs is what immediately
 * precedes it, and handing back a novel to write its last chapter is the
 * problem this exists to avoid.
 *
 * The cut moves forward to the next structural boundary — a heading, a blank
 * line, a top-level definition — rather than landing wherever the byte count
 * fell. A slice that opens mid-sentence is read as the sentence's beginning,
 * and the model continues a thought whose first half it never saw; in code it
 * is worse, because half a function body looks like a function to imitate.
 * Better to show less and have it start somewhere real.
 */
export function boundaryTail(text: string, chars = 2000): string {
  if (text.length <= chars) return text;
  const window = text.slice(-chars);
  // Search only the first third: past that, honouring the boundary would cost
  // most of what was asked for.
  const limit = Math.floor(window.length / 3);
  let best = -1;
  for (const re of [/\n#{1,6} /g, /\n(?:export |function |class |def |const |async )/g, /\n\n/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(window))) {
      if (m.index > limit) break;
      if (m.index > best) best = m.index;
    }
    if (best >= 0) break;
  }
  return `…\n${window.slice(best >= 0 ? best + 1 : 0)}`;
}

function tail(file: string, chars = 2000): string {
  if (!existsSync(file)) return "";
  try {
    return boundaryTail(readFileSync(file, "utf8"), chars);
  } catch {
    return "";
  }
}

/**
 * Everything wrong with the artefact, as a list.
 *
 * Extracted from `write_check` so the step runner can call it too. The tool is
 * the model asking "how am I doing"; this is the portal asking the same
 * question before it lets an answer be written — BirdClaw's write guard and
 * subtask verifier, which existed because a model will finish a file, believe
 * it is done, and be wrong in ways that are mechanically visible: a section
 * that shrank because the file was rewritten instead of appended to, a stub
 * left in, code that does not parse.
 *
 * None of those need a model to notice, which is exactly why they should not
 * be left to one.
 */
export function checkDocument(file: string, tasks: TaskRow[]): string[] {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const done = tasks.filter((t) => t.status === "done");
  const problems: string[] = [];

  const expected = done.reduce((sum: number, t: TaskRow) => {
    const m = /^(\d+) chars/.exec(String(t.result ?? ""));
    return sum + (m ? Number(m[1]) : 0);
  }, 0);
  if (expected && text.length < expected * 0.8) {
    problems.push(
      `The file is ${text.length} characters but the sections written add up to about ` +
        `${expected}. Something overwrote earlier work rather than appending to it.`,
    );
  }

  const language = languageOf(file);
  for (const stub of language
    ? ["TODO", "FIXME", "[placeholder]", "not implemented"]
    : ["TODO", "TBD", "...", "[placeholder]", "coming soon"]) {
    if (text.includes(stub)) problems.push(`"${stub}" is still in the text.`);
  }
  if (!text.trim() && done.length) {
    problems.push("The plan says sections are written but the file is empty.");
  }

  if (language && text.trim()) {
    const syntax = language.check?.(file);
    if (syntax) problems.push(`It does not parse:\n${syntax}`);
    else {
      const open = unbalanced(text);
      if (open) problems.push(open);
    }
  }
  return problems;
}

/**
 * The section being written now.
 *
 * `running` first, then the first `pending`. Looking only at `pending` — which
 * is what this did — silently skips a step that `task_start` has marked
 * running, and the text intended for it is recorded against the *next* one. A
 * live run did exactly that: `task_start` on "area", then `write_next` wrote
 * the area function and filed it under "perimeter", leaving "area" to be closed
 * with prose by `task_finish` and the file with one section where there should
 * have been two. Nothing errors; the plan simply stops describing the file.
 */
function currentSection(tasks: TaskRow[]): TaskRow | undefined {
  return tasks.find((t) => t.status === "running") ?? tasks.find((t) => t.status === "pending");
}

/**
 * A session workspace nobody chose.
 *
 * `/workspaces/session-<id>` is made for one conversation and outlives nothing.
 * A workspace a person created and named is a different thing and keeps its
 * files where they put them.
 */
function isEphemeral(cwd: string): boolean {
  return /(^|\/)session-[A-Za-z0-9_-]+\/?$/.test(path.resolve(cwd));
}

/** The request this session is serving, which names the work in the store. */
async function lastRequestOf(sessionId: string): Promise<string> {
  try {
    const rows = await eventsSince(sessionId, 0, 2000);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type !== "portal_prompt") continue;
      const message = JSON.parse(rows[i].payload)?.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  } catch {
    /* an unnamed piece of work still gets a home, just a duller one */
  }
  return "";
}

/** Keep the sidecar in step with the plan, so the next run can adopt it. */
async function saveArtefactPlan(sessionId: string, file: string): Promise<void> {
  if (!isArtefact(file)) return;
  const tasks = await listTasks(sessionId);
  writeArtefactPlan(file, {
    goal: await lastRequestOf(sessionId),
    updatedAt: new Date().toISOString(),
    sections: tasks.map((t) => ({ description: t.description, status: t.status, result: String(t.result ?? "") })),
  });
}

export function writingTools(sessionId: string | undefined, cwd: string) {
  return (pi: any): void => {
    if (!sessionId) return;

    pi.registerTool({
      name: "write_plan",
      label: "Plan a document",
      description:
        "Plan a document or program with named parts, then write each with write_next. The test " +
        "is structure, not length: if you can name the pieces before writing them — sections of a " +
        "report, functions of a module — plan them here. Two is enough. Each part is then written " +
        "in a context of its own holding the plan and what earlier parts produced, so it gets your " +
        "full attention rather than what is left after everything before it; the file on disk is " +
        "the state, so an interruption costs one part instead of all of them. Use write instead " +
        "only for something with no parts: one function, a config file, a note.\n\n" +
        "`sections` is a flat list of plain strings, in the order they should be written:\n\n" +
        '  {"file": "stats.mjs", "sections": ["mean", "median", "stddev", "summary"]}\n\n' +
        "Name the parts, not the process — \"mean\", not \"write the mean function\", and never a " +
        "step for planning: this call is the plan. Each part is written in a context of its own, so " +
        "name it in a way that means something on its own: \"rollback procedure\", not \"the rest\".",
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
        if (!file) throw new Error("No file given — pass the path to write.");
        if (!sections.length) throw new Error("No sections given — name the parts before planning them.");

        /**
         * Resolved against the *session's* workspace, not the server's cwd.
         *
         * A model asked to write "guide.md" gives exactly that, and
         * `path.resolve` on a relative path uses `process.cwd()` — which is
         * wherever the portal was started. The first live test wrote the file
         * into the Phoenixclaw checkout instead of the workspace, reported
         * success, and left the agent unable to find what it had just written.
         */
        /**
         * A plan already part-written is not re-planned.
         *
         * Each section records where it landed in the file, and `read_section`
         * and `write_revise` navigate by that. Replacing the plan throws those
         * away while the text stays on disk, so the document silently stops
         * corresponding to the plan describing it.
         *
         * It also closes a loop that cost a live run everything it had done.
         * Working a plan step by step, the step's own context contained a file
         * and a plan and no memory of having written either — so the model
         * called `write_plan` again, which reset the four sections it was
         * partway through, and the run stalled with nothing written. From
         * inside that context it was a reasonable call. It is this tool's job
         * to know better.
         */
        const inProgress = await listTasks(sessionId);
        const written = inProgress.filter((t: TaskRow) => t.status === "done" && /@\d+-\d+$/.test(String(t.result ?? "")));
        const stillToWrite = inProgress.filter((t: TaskRow) => t.status === "pending" || t.status === "running");
        if (written.length && stillToWrite.length) {
          return said(
            `You are already partway through this — ${written.length} of ${inProgress.length} sections ` +
              `written, and "${stillToWrite[0].description}" is next.\n\n${render(inProgress)}\n\n` +
              `Write the next section with \`write_next\`. To change something already written, use ` +
              `\`write_revise\`; to drop a section you no longer want, \`write_skip\`. Re-planning now ` +
              `would leave the text on disk with nothing describing it.`,
          );
        }

        /**
         * Where a planned document belongs.
         *
         * An absolute path, or a relative one inside a workspace somebody
         * chose, is exactly where it says. A relative path in an *ephemeral*
         * session workspace is not: that directory exists for the length of
         * one conversation, so the document written there is thrown away and
         * the next run at the same request writes it again from nothing. Those
         * go to the shared store, where a second run finds the first — see
         * artefacts.ts.
         */
        const goal = await lastRequestOf(sessionId);
        /**
         * Which file this run opens.
         *
         * Recall first, because "is this the same work?" is a semantic
         * question and `workSlug` cannot answer it — it names a *new* artefact
         * after its file, which is predictable but blind to wording. The
         * embedding search in prior-work.ts is what actually recognises that
         * this request has been served before, whatever words it used, and
         * hands back the file that answered it.
         */
        let target: string;
        if (path.isAbsolute(file)) {
          target = file;
        } else if (isEphemeral(cwd)) {
          const prior = p?.overwrite === true ? undefined : await priorWork(goal, cwd);
          target =
            prior && isArtefact(prior.file) && path.basename(prior.file) === path.basename(file)
              ? prior.file
              : artefactPath(goal, file);
        } else {
          target = path.join(cwd, file);
        }
        mkdirSync(path.dirname(target), { recursive: true });

        /**
         * Continuing an artefact rather than appending a second copy under it.
         *
         * The sidecar holds the sections the last run wrote and where each
         * landed. Adopted, they become this session's plan, so the model can
         * read and revise them; without it a run opening an existing artefact
         * has the text and no idea what its parts are, and `write_next`
         * cheerfully appends a whole second document underneath the first.
         */
        const carried = p?.overwrite === true ? undefined : readArtefactPlan(target);
        if (carried?.sections.length && existsSync(target)) {
          await updateSession(sessionId, { writing_file: target });
          await clearTasks(sessionId);
          const existingNames = carried.sections.map((sec) => sec.description);
          const added = sections.filter((s: string) => !existingNames.includes(s));
          await setTasks(sessionId, [...existingNames, ...added]);
          for (const sec of carried.sections) {
            const seq = existingNames.indexOf(sec.description) + 1;
            // The sidecar is a file on disk and may have been edited by hand;
            // an unrecognised status is treated as unwritten rather than
            // trusted into the plan.
            const status = (["pending", "running", "done", "failed"] as const).find((x) => x === sec.status) ?? "pending";
            await setTaskStatus(sessionId, seq, status, sec.result);
          }
          const history = artefactHistory(target, 5);
          return said(
            `This already exists — you wrote it before, and it is still here:\n\n${target}\n\n` +
              `That is the full path; it is kept outside this session so it survives, so it is not in ` +
              `your working directory and \`ls\` here will not show it.\n\n` +
              `${render(await listTasks(sessionId))}\n\n` +
              (history.length ? `Its history:\n${history.map((h) => `  ${h}`).join("\n")}\n\n` : "") +
              `Do not start it again. Read what is there with \`read_section\`, change what is wrong ` +
              `with \`write_revise\`` +
              (added.length
                ? `, and write the ${added.length} new section(s) with \`write_next\`.`
                : `. Every section it planned is already written — if nothing needs changing, say so.`) +
              `\n\nThis is the point of keeping it: the second attempt improves the first rather than ` +
              `producing a second copy of it.`,
            { planned: added.length > 0 },
          );
        }

        if (p?.overwrite === true || !existsSync(target)) writeFileSync(target, "", "utf8");

        await updateSession(sessionId, { writing_file: target });
        // Replaces the session's plan: writing a document *is* what this
        // session is doing, and two plans would be two answers to that.
        // Said out loud below, because it happening silently is what let a
        // live run finish "step 2" of a plan that no longer existed.
        const replaced = (await listTasks(sessionId)).length;
        await clearTasks(sessionId);
        await setTasks(sessionId, sections);

        /**
         * The nudge, and where it goes.
         *
         * Not for code. It asks whether a document's claims about the world
         * were checked, and a module of arithmetic makes none — a `mean`
         * function is not a factual assertion that could be looked up. Firing
         * it there is a warning that is wrong every time, which trains the
         * model to skip the ones that are right.
         *
         * And it goes *before* the instruction, not after. The first live run
         * of this planned five sections, read a closing paragraph about not
         * writing from recollection, and ended the turn without writing a
         * line. Whatever a tool result ends on is what the model does next, so
         * it ends on the thing to do.
         */
        const looked = languageOf(target) ? true : await hasLookedAnythingUp(sessionId);
        return said(
          `Planned ${sections.length} section(s) of ${target}:\n` +
            sections.map((s: string, i: number) => `  ${i + 1}. ${s}`).join("\n") +
            (looked
              ? ""
              : `\n\nYou have not looked anything up in this conversation. If any of this states ` +
                `facts about the world — a tool's behaviour, a version, what something does — find ` +
                `out first rather than writing what you believe: search your memory, read the ` +
                `source, fetch the page. A document written from recollection reads exactly like ` +
                `one that was checked. If it is genuinely something you know or are reasoning ` +
                `about, carry on.`) +
            (replaced
              ? `\n\nThis replaces the ${replaced}-step plan you had. These sections are the plan now — ` +
                `step numbers from the old one no longer mean anything.`
              : "") +
            selfContainmentNote(sections) +
            `\n\nStop here. Do not write any of it in this turn.\n\n` +
            `Each section will be given back to you on its own, in a context holding the plan, what ` +
            `the earlier sections produced, and the end of the file — and nothing else. That is the ` +
            `point: section four gets the attention section one got, instead of what is left after ` +
            `three sections of working. Say what you have planned and finish your turn.`,
          // The portal ends the turn here rather than trusting the sentence
          // above (session-manager.ts). Flagged rather than matched on text,
          // so a refusal further up is not mistaken for a plan being set.
          { planned: true },
        );
      },
    });

    /**
     * A project is files, and files have an order.
     *
     * Ports Sisyphean's project planner (`translation/project/planner.py`),
     * which the audit left as "IDEA SURVIVES" and nobody built. `write_plan`
     * plans the sections of *one* file, and the three arguments for doing that
     * apply just as hard to six files: a model asked to write a whole project
     * in one turn writes the last file with the least budget left, and a run
     * that dies at file four leaves an unbuildable tree with no record of what
     * was intended.
     *
     * Dependency order is the part that is specific to files rather than
     * sections. Sections can be written in any order and read in one; a module
     * that imports from another has to be written after it, or the earlier
     * file's real signatures are not there to match — which is exactly the
     * failure `signaturesOf` exists to prevent within a file, one level up.
     *
     * Sisyphean asked a 0.6B model for this order with a JSON schema and a
     * 600-token budget. Here it is a parameter: the model states the order it
     * intends, and the plan holds it.
     */
    pi.registerTool({
      name: "write_project",
      label: "Plan a project",
      description:
        "Plan a project of several files, then write them one at a time with write_next. List them " +
        "in dependency order — the files that others import from first, the entry point last — " +
        "because each file is written in a context holding what the earlier ones actually declare, " +
        "and a file written before the thing it imports has nothing to match. Give each a purpose " +
        "naming the functions or classes it will hold, not a vague description:\n\n" +
        '  {"files": [{"file": "tokens.mjs", "purpose": "Token type and the TOKEN_KINDS table"}, ' +
        '{"file": "lexer.mjs", "purpose": "tokenise(source) -> Token[], using tokens.mjs"}]}\n\n' +
        "Use write_plan instead for one file with several parts.",
      promptSnippet: "write_project — plan a project's files in dependency order",
      parameters: Type.Object({
        files: Type.Array(
          Type.Object({
            file: Type.String({ description: "Filename, no directories." }),
            purpose: Type.String({ description: "What it will contain — name the functions or classes." }),
          }),
          { description: "In dependency order: what others import from, first." },
        ),
      }),
      async execute(_id: string, p: any) {
        const files = (Array.isArray(p?.files) ? p.files : [])
          .map((f: any) => ({
            file: String(f?.file ?? "").trim(),
            purpose: String(f?.purpose ?? "").trim(),
          }))
          .filter((f: any) => f.file);
        if (!files.length) {
          throw new Error(
            'No files given. Copy this shape exactly:\n\n' +
              '  {"files": [{"file": "tokens.mjs", "purpose": "Token type and TOKEN_KINDS"}, ' +
              '{"file": "lexer.mjs", "purpose": "tokenise(source) -> Token[]"}]}',
          );
        }

        const goal = await lastRequestOf(sessionId);
        /**
         * The project gets a directory of its own.
         *
         * Its files import each other by relative path, so they have to sit
         * together — and in the shared store rather than a session workspace,
         * for the reason every artefact does: the next run at this project
         * should find it. `artefactPath` names the directory after the file,
         * which is right for one document and wrong for several, so the
         * project is named after itself.
         */
        const root = isEphemeral(cwd)
          ? path.join(path.dirname(artefactPath(goal, files[0].file)), "..", projectSlug(goal, files))
          : cwd;
        const dir = path.resolve(root);
        mkdirSync(dir, { recursive: true });

        await clearTasks(sessionId);
        await setTasks(
          sessionId,
          files.map((f: any) => `${f.file} — ${f.purpose}`.slice(0, 300)),
        );
        await updateSession(sessionId, {
          writing_mode: "files",
          writing_file: path.join(dir, files[0].file),
        });

        return said(
          `Planned ${files.length} file(s) in ${dir}:\n` +
            files.map((f: any, i: number) => `  ${i + 1}. ${f.file} — ${f.purpose}`).join("\n") +
            selfContainmentNote(files.map((f: any) => f.purpose)) +
            `\n\nStop here. Do not write any of them in this turn.\n\n` +
            `Each file comes back to you on its own, with the plan and what the earlier files ` +
            `declare. Write each with \`write_next\` — the whole file, in one call, since the file ` +
            `is the unit here rather than the section.`,
          { planned: true },
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
        const session = await getSession(sessionId);
        const file = session?.writing_file;
        if (!file) throw new Error("No document in progress. Start one with write_plan or write_project — calling this again will say the same.");

        const pending = currentSection(await listTasks(sessionId));
        if (!pending) {
          return said(
            session?.writing_mode === "files"
              ? "Every planned file is written. The project is finished."
              : "Every planned section is written. The document is finished.",
          );
        }

        /**
         * A project's unit is the file, not the section.
         *
         * Appending would be wrong twice over: the second file would land
         * inside the first, and the span bookkeeping that makes `read_section`
         * work describes offsets in one document. So a file is written whole,
         * and `writing_file` moves to the next one — which is what makes the
         * *next* step's brief show what the file it depends on actually
         * declares.
         */
        if (session?.writing_mode === "files") {
          const content = String(p?.content ?? "").trimEnd();
          if (content.length < MIN_SECTION_CHARS) {
            return said(
              `That is ${content.length} characters — too short for a whole file. Write ` +
                `"${pending.description}" properly, or use write_skip if it turned out unnecessary.`,
            );
          }
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${content}\n`, "utf8");
          await setTaskStatus(sessionId, pending.seq, "done", `${content.length} chars in ${path.basename(file)}`);
          commitArtefact(file, `wrote ${path.basename(file)}`);

          const left = (await listTasks(sessionId)).filter(
            (t: TaskRow) => t.status === "pending" || t.status === "running",
          );
          const language = languageOf(file);
          const syntax = language?.check?.(file);
          if (!left.length) {
            return said(
              `Wrote ${path.basename(file)} (${content.length} chars). The project is complete: ` +
                `${path.dirname(file)}` + (syntax ? `\n\nBut it does not parse:\n${syntax}` : ""),
            );
          }
          // The next file's name is the part before the em dash the plan stored.
          const nextName = left[0].description.split(" — ")[0].trim();
          await updateSession(sessionId, { writing_file: path.join(path.dirname(file), nextName) });
          return said(
            `Wrote ${path.basename(file)} (${content.length} chars).` +
              (syntax ? `\n\nIt does not parse:\n${syntax}` : "") +
              `\n\nNext: ${left[0].description}`,
            { wrote: pending.seq },
          );
        }

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
        const separator = existing && !existing.endsWith("\n\n") ? "\n\n" : "";
        appendFileSync(file, `${separator}${content}\n`, "utf8");
        // Where it landed, not just how long it was — see Span. This is what
        // makes read_section and write_revise possible at all.
        const start = existing.length + separator.length;
        await setTaskStatus(sessionId, pending.seq, "done", spanResult({ start, end: start + content.length }));
        await saveArtefactPlan(sessionId, file);
        commitArtefact(file, `wrote ${pending.description}`);

        const left = (await listTasks(sessionId)).filter(
          (t: TaskRow) => t.status === "pending" || t.status === "running",
        );
        if (!left.length) {
          // The path stays on the session. Clearing it here made the document
          // unreachable at the exact moment it was finished — read_section and
          // write_revise both answered "no document in progress" once the last
          // section landed, which is when you are most likely to look back at
          // what you wrote. Completion is already visible in the plan: every
          // step done, and write_next says so before it gets this far.
          return said(`Wrote "${pending.description}". The document is complete: ${file}`, {
            wrote: pending.seq,
          });
        }

        return said(
          `Wrote "${pending.description}" (${content.length} chars).\n\n` +
            `Next: "${left[0].description}". What is already there ends with:\n\n${tail(file, 600)}`,
          // Which section this closed, so the portal can end the turn when the
          // section it briefed is done — see session-manager.ts. Without it the
          // model carried straight on through the remaining sections in the
          // same context, which is the accumulation this exists to avoid.
          { wrote: pending.seq },
        );
      },
    });

    pi.registerTool({
      name: "write_check",
      label: "Check the document so far",
      description:
        "Read back what has been written and what is left. Use it when you have lost your place, " +
        "after an interruption, or before finishing — it reports anything that looks wrong: a " +
        "section that shrank, a stub left behind, a plan that no longer matches the file.",
      promptSnippet: "write_check — see what is written, what is left, and what looks wrong",
      parameters: Type.Object({}),
      async execute() {
        const file = (await getSession(sessionId))?.writing_file;
        if (!file) throw new Error("No document in progress — there is nothing to read back or revise.");

        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        const tasks = await listTasks(sessionId);
        const done = tasks.filter((t: TaskRow) => t.status === "done");
        const left = tasks.filter((t: TaskRow) => t.status === "pending" || t.status === "running");

        /**
         * What Sisyphean's verifier checked, kept and re-aimed.
         *
         * Its regression test — a section that was complete and is now much
         * shorter means the model rewrote the file instead of appending — is
         * not about model size at all. It is about a mistake any writer can
         * make with a whole-file `write` tool, and it is silent: the document
         * looks finished and half of it is gone.
         */
        const problems: string[] = [];
        const expected = done.reduce((sum: number, t: TaskRow) => {
          const m = /^(\d+) chars/.exec(String(t.result ?? ""));
          return sum + (m ? Number(m[1]) : 0);
        }, 0);
        if (expected && text.length < expected * 0.8) {
          problems.push(
            `The file is ${text.length} characters but the sections written add up to about ` +
              `${expected}. Something overwrote earlier work rather than appending to it.`,
          );
        }
        /**
         * Stubs, judged by what the file is.
         *
         * `...` is an ellipsis in an essay and a spread operator in
         * JavaScript, so scanning for it in code reported every
         * `foo(...args)` as an unfinished document — a warning that is wrong
         * often enough to be ignored, which is the worst kind.
         */
        const language = languageOf(file);
        for (const stub of language
          ? ["TODO", "FIXME", "[placeholder]", "not implemented"]
          : ["TODO", "TBD", "...", "[placeholder]", "coming soon"]) {
          if (text.includes(stub)) problems.push(`"${stub}" is still in the text.`);
        }
        if (!text.trim() && done.length) {
          problems.push("The plan says sections are written but the file is empty.");
        }

        /**
         * For code, whether it actually parses.
         *
         * The check a document cannot have and a program must: a module
         * assembled a function at a time can be the right length, have every
         * planned section, and not compile. `write_check` was reporting
         * "nothing looks wrong" about files that would not load.
         */
        if (language && text.trim()) {
          const syntax = language.check?.(file);
          if (syntax) problems.push(`It does not parse:\n${syntax}`);
          else {
            const open = unbalanced(text);
            if (open) problems.push(open);
          }
        }

        return said(
          [
            `${file} — ${text.length} characters, ${done.length} of ${tasks.length} section(s) written.`,
            left.length ? `Still to write: ${left.map((t: TaskRow) => t.description).join(", ")}.` : "All sections written.",
            problems.length ? `\nProblems:\n${problems.map((x) => `- ${x}`).join("\n")}` : "\nNothing looks wrong.",
            text ? `\nIt ends with:\n\n${tail(file, 800)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    });

    /**
     * Reading one section back, by its number.
     *
     * Not `read`: the model would have to know the file's path and then find
     * the section in it, and the tail it was given does not say where anything
     * starts. This is the operation the plan already has the information for.
     */
    pi.registerTool({
      name: "read_section",
      label: "Read a written section",
      description:
        "Read back one section you have already written, by its number in the plan. Use it when a " +
        "later section has to match an earlier one — a function's signature, a term you defined, a " +
        "claim you are about to build on — rather than working from what you remember writing.",
      promptSnippet: "read_section — read back a section you already wrote",
      parameters: Type.Object({
        section: Type.Number({ description: "The section's number, as shown in the plan." }),
      }),
      async execute(_id: string, p: any) {
        const file = (await getSession(sessionId))?.writing_file;
        if (!file) throw new Error("No document in progress — there is nothing to read back or revise.");
        const seq = Number(p?.section);
        const task = (await listTasks(sessionId)).find((t: TaskRow) => t.seq === seq);
        if (!task) return said(`There is no section ${seq} in this plan.`);
        if (task.status !== "done") return said(`Section ${seq} ("${task.description}") is not written yet.`);

        const span = spanOf(task.result);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        if (!span || span.end > text.length) {
          // Written before spans were recorded, or the file has been edited
          // from outside. Say so rather than returning a confident wrong slice.
          return said(
            `Section ${seq} ("${task.description}") is written but I cannot locate it in the file — ` +
              `it may have been edited outside this plan. Read ${file} directly.`,
          );
        }
        return said(`Section ${seq} — "${task.description}":\n\n${text.slice(span.start, span.end)}`);
      },
    });

    /**
     * Rewriting a section in place.
     *
     * The gap that made this an append-only tool. Writing a module one function
     * at a time means discovering at function seven that function three had the
     * wrong signature — and until now the only way to fix it was a whole-file
     * `write`, which is the thing this exists to avoid and which write_check
     * then reports as data loss.
     *
     * Later sections move, so their spans move with it. Getting that wrong
     * would leave read_section returning text that has drifted a few hundred
     * characters, which is worse than not having it.
     */
    pi.registerTool({
      name: "write_revise",
      label: "Revise a section",
      description:
        "Replace a section you have already written, keeping everything around it. Use it when " +
        "later work shows an earlier section was wrong — a signature that changed, a claim you have " +
        "since checked — instead of rewriting the whole file.",
      promptSnippet: "write_revise — replace one already-written section in place",
      parameters: Type.Object({
        section: Type.Number({ description: "The section's number, as shown in the plan." }),
        content: Type.String({ description: "The section's new full text, replacing the old." }),
      }),
      async execute(_id: string, p: any) {
        const file = (await getSession(sessionId))?.writing_file;
        if (!file) throw new Error("No document in progress — there is nothing to read back or revise.");
        const seq = Number(p?.section);
        const tasks = await listTasks(sessionId);
        const task = tasks.find((t: TaskRow) => t.seq === seq);
        if (!task) return said(`There is no section ${seq} in this plan.`);
        if (task.status !== "done") return said(`Section ${seq} is not written yet — write_next writes it.`);

        const span = spanOf(task.result);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        if (!span || span.end > text.length) {
          return said(
            `I cannot locate section ${seq} in the file — it may have been edited outside this plan. ` +
              `Read ${file} and edit it directly.`,
          );
        }
        const content = String(p?.content ?? "").trimEnd();
        if (content.length < MIN_SECTION_CHARS) {
          return said(
            `That is ${content.length} characters — too short to replace "${task.description}". ` +
              `Use write_skip if the section should go.`,
          );
        }

        writeFileSync(file, text.slice(0, span.start) + content + text.slice(span.end), "utf8");

        // Everything after it shifts. Left unmoved, read_section would start
        // returning text a few hundred characters off — confidently wrong,
        // which is worse than refusing.
        const delta = content.length - (span.end - span.start);
        await setTaskStatus(sessionId, seq, "done", spanResult({ start: span.start, end: span.start + content.length }));
        if (delta !== 0) {
          for (const other of tasks) {
            const s = spanOf(other.result);
            if (other.seq === seq || !s || s.start < span.end) continue;
            await setTaskStatus(sessionId, other.seq, other.status, spanResult({ start: s.start + delta, end: s.end + delta }));
          }
        }

        await saveArtefactPlan(sessionId, file);
        commitArtefact(file, `revised ${task.description}`);

        const language = languageOf(file);
        const syntax = language?.check?.(file);
        return said(
          `Revised section ${seq} ("${task.description}") — ${span.end - span.start} chars became ${content.length}.` +
            (syntax ? `\n\nBut the file no longer parses:\n${syntax}` : ""),
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
        const pending = currentSection(await listTasks(sessionId));
        if (!pending) throw new Error("Nothing left to skip — every planned section is written or skipped.");
        await setTaskStatus(sessionId, pending.seq, "failed", String(p?.why ?? "skipped").slice(0, 300));
        const left = (await listTasks(sessionId)).filter(
          (t: TaskRow) => t.status === "pending" || t.status === "running",
        );
        return said(
          left.length
            ? `Skipped "${pending.description}". Next: "${left[0].description}".`
            : `Skipped "${pending.description}". Nothing left — the document is finished.`,
        );
      },
    });
  };
}
