import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where finished work lives, once, instead of once per session.
 *
 * Sessions get their own workspace and may only write inside it (guard.ts), so
 * every run that produced a document produced a *new* one: three runs asked for
 * the same module left three geometry.mjs files in three throwaway
 * directories, each written from scratch. The knowledge carried forward — a
 * later run could see what an earlier one decided, and did — but the artefact
 * never did, so the same text was generated again every time and the disk
 * filled with near-duplicates that nothing would ever read.
 *
 * So there is one shared directory, outside any session's workspace, and a
 * planned document goes there. A second run at the same work opens the file
 * that exists rather than making another.
 *
 * ## What this gives up, stated plainly
 *
 * The workspace boundary is the portal's answer to cross-contamination: a
 * session may read anything and write only its own area. This is a hole in
 * that, deliberately opened, and it should be understood as one — two sessions
 * can now reach the same file.
 *
 * What keeps it from being a general hole:
 *
 *   - It is one directory, not a lifted restriction. Everything outside a
 *     session's workspace and this path is refused exactly as before.
 *   - Only *planned* documents land here. `write` and `edit` are still bounded
 *     to the workspace, so nothing arrives by accident — a file gets here
 *     because a plan was written for it.
 *   - Each artefact carries the plan that built it (`<file>.plan.json`), so a
 *     later run continues the sections that exist rather than appending a
 *     second copy underneath them.
 *
 * What it does not solve, and is not pretended to: two sessions planning the
 * same artefact at the same time. The second would adopt a file the first is
 * still writing. Sequential reuse is the case this is for.
 */

/** Under `/data` because that is the volume — see CLAUDE.md on persistence. */
export const ARTEFACTS_DIR = path.resolve(
  process.env.ARTEFACTS_DIR || path.join(process.env.DATA_DIR || "./data", "artefacts"),
);

export function ensureArtefactsDir(): void {
  mkdirSync(ARTEFACTS_DIR, { recursive: true });
}

/** True when `file` is inside the shared artefact store. */
export function isArtefact(file: string): boolean {
  const rel = path.relative(ARTEFACTS_DIR, path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A stable directory name for a piece of work.
 *
 * This was a slug of the significant words of the request, so that asking
 * twice reached the same file. It does not survive contact with real wording:
 * "write geometry.mjs with area and perimeter" and "write a geometry.mjs
 * exporting perimeter and area" differ by one word that is not on any
 * stop-list, and land in different directories — which is the whole failure
 * the store exists to prevent, reintroduced by its own naming.
 *
 * No amount of stop-word tuning fixes that; the question "is this the same
 * work?" is a semantic one and there is already something in this codebase
 * that answers semantic questions. `prior-work.ts` recalls earlier artefacts
 * by embedding the request, and its answer is what actually decides which file
 * a run opens (see write_plan). This only has to name a *new* artefact, so it
 * names it after the file: predictable, and legible to a person looking in the
 * directory.
 *
 * Two unrelated pieces of work that both produce "notes.md" therefore meet.
 * That is deliberate rather than overlooked — the second run is shown what is
 * already there and what it was for, and can revise it or start fresh with
 * `overwrite`. Surfacing the collision is better than hiding it behind a hash
 * nobody can read.
 */
export function workSlug(goal: string, file: string): string {
  const base = path.basename(file || "").trim();
  const stem = base.replace(/\.[^.]+$/, "");
  const safe = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 80) || "untitled";
}

/**
 * A project is several files that import each other, so it gets a directory.
 *
 * Named after its entry point — the last file in dependency order, which is
 * the one a person would run — rather than the first, which is usually
 * something like `types.mjs` and says nothing about what the project is.
 */
export function projectSlug(goal: string, files: Array<{ file: string }>): string {
  const entry = files[files.length - 1]?.file ?? "";
  const stem = path.basename(entry).replace(/\.[^.]+$/, "");
  const safe = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "project"}-project`.slice(0, 80);
}

/** Where a planned document belongs in the store. */
export function artefactPath(goal: string, file: string): string {
  return path.join(ARTEFACTS_DIR, workSlug(goal, file), path.basename(file));
}

/**
 * The plan that built an artefact, stored beside it.
 *
 * BirdClaw's principle is that the file is the memory; this is the half that
 * makes it usable. Without it a second run opening an existing artefact has
 * the text and no idea what its parts are, so it appends a whole second copy
 * underneath the first. With it, the run adopts the sections — names and the
 * spans `write_next` recorded — and can revise them individually.
 *
 * A sidecar rather than a column or a graph node: it travels with the file, it
 * survives anything that copies the directory, and it can be read by a person
 * who has no access to either database.
 */
export interface ArtefactPlan {
  goal: string;
  updatedAt: string;
  sections: Array<{ description: string; status: string; result: string }>;
}

const sidecarFor = (file: string) => `${file}.plan.json`;

export function writeArtefactPlan(file: string, plan: ArtefactPlan): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(sidecarFor(file), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  } catch {
    // The artefact is the deliverable; its index failing to save must not fail
    // the run that produced it.
  }
}

export function readArtefactPlan(file: string): ArtefactPlan | undefined {
  const sidecar = sidecarFor(file);
  if (!existsSync(sidecar)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as ArtefactPlan;
    if (!Array.isArray(parsed?.sections)) return undefined;
    /**
     * A plan whose spans no longer fit the file is worse than none.
     *
     * Something edited the artefact from outside — a person, another tool —
     * and the recorded offsets now point at the wrong text. Adopting them
     * would have `read_section` return confidently wrong slices and
     * `write_revise` overwrite the wrong bytes.
     */
    const size = existsSync(file) ? readFileSync(file, "utf8").length : 0;
    for (const section of parsed.sections) {
      const m = /@(\d+)-(\d+)$/.exec(String(section.result ?? ""));
      if (m && Number(m[2]) > size) return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * History, by using the thing that is already good at it.
 *
 * The store answers "is there one of these already"; git answers everything
 * that comes next — what changed between the first attempt and the second, what
 * a section looked like before it was revised, and how to get back when a run
 * makes something worse. All of which the portal would otherwise have to build,
 * badly: `write_check`'s shrink detector can tell you an earlier section was
 * eaten, and without history that is a diagnosis with no cure.
 *
 * A commit per section rather than per run, because the section is the unit
 * this whole design is built on. It makes a run's history readable as what it
 * is — "wrote area", "wrote perimeter", "revised area" — instead of one commit
 * containing a file that appeared.
 *
 * Entirely best-effort. Every call swallows its failure: git missing, a repo
 * that will not initialise, a commit that races another session. The artefact
 * is the deliverable and its history is not worth failing a run over.
 */

/** Committed as the agent, with the identity passed per-call so no global config is touched. */
const GIT_IDENTITY = [
  "-c", "user.name=Phoenixclaw",
  "-c", "user.email=agent@phoenixclaw.local",
  "-c", "commit.gpgsign=false",
];

function git(args: string[], cwd = ARTEFACTS_DIR): { ok: boolean; out: string } {
  try {
    const r = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8", timeout: 15_000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Make the store a repository, once. Safe to call on every write. */
export function ensureArtefactRepo(): boolean {
  ensureArtefactsDir();
  if (existsSync(path.join(ARTEFACTS_DIR, ".git"))) return true;
  return git(["init", "--quiet", "--initial-branch=main"]).ok;
}

/**
 * Record what just changed.
 *
 * Scoped to the artefact and its sidecar rather than `git add -A`: another
 * session may be writing a different artefact in the same repository at the
 * same moment, and committing its half-finished work under this run's message
 * would make the history actively misleading.
 */
export function commitArtefact(file: string, message: string): void {
  if (!isArtefact(file) || !ensureArtefactRepo()) return;
  const rel = path.relative(ARTEFACTS_DIR, file);
  /**
   * Only paths that exist.
   *
   * `git add -- a b` fails outright when b is missing — "pathspec did not
   * match any files" — and stages *neither*. The sidecar is written after the
   * first section in some paths and not at all in others, so naming it
   * unconditionally meant the first commit of every artefact silently staged
   * nothing and the history stayed empty.
   */
  const paths = [rel, `${rel}.plan.json`].filter((rp) => existsSync(path.join(ARTEFACTS_DIR, rp)));
  if (!paths.length) return;
  git(["add", "--", ...paths]);
  // Nothing to commit is the ordinary case for a no-op revision, not a failure.
  git(["commit", "--quiet", "-m", message.slice(0, 200) || "update", "--", ...paths]);
}

/** What has happened to this artefact, newest first. Empty when there is no history. */
export function artefactHistory(file: string, limit = 20): string[] {
  if (!isArtefact(file) || !existsSync(path.join(ARTEFACTS_DIR, ".git"))) return [];
  const rel = path.relative(ARTEFACTS_DIR, file);
  const r = git(["log", `-${limit}`, "--format=%ad  %s", "--date=short", "--", rel]);
  return r.ok && r.out ? r.out.split("\n").filter(Boolean) : [];
}
