import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The mechanical half of self-update's safety.
 *
 * The routine's instructions already say "check git status is clean before
 * starting" and "if it fails, run git checkout -- . to discard the change".
 * That is the model policing itself, and pi/constitution.ts says plainly why
 * that is not enough on its own: "the model will eventually follow instructions
 * it should not, so the boundary cannot be a paragraph asking it not to." An
 * unattended run editing the source of the portal it is running inside is the
 * least forgiving place to rely on good intentions — a broken build is not
 * noticed until the next restart, which is exactly when it cannot be fixed from
 * here.
 *
 * So the same three steps happen around the run whatever the model does:
 * refuse to start on a dirty tree, verify afterwards, and revert what does not
 * build.
 *
 * BirdClaw had all three (`agent/self_update.py`); this is that envelope,
 * expressed against git rather than against its own snapshot format.
 */

/** How long a verify may take. pi's workspace build chains six packages. */
const VERIFY_TIMEOUT_MS = 15 * 60_000;

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run("git", args, { cwd, timeout: 60_000, maxBuffer: 8 << 20 });
  return stdout.trim();
};

/** A tree the self-update routine is allowed to touch, and how to prove it still works. */
export interface Tree {
  path: string;
  /** Run from `path`. A non-zero exit reverts the tree. */
  verify: string[];
}

/**
 * Both trees named in the routine's own instructions.
 *
 * Discovered rather than assumed: a deployment without the pi checkout beside
 * it (the Docker image installs pi from npm) simply has one tree, and a verify
 * that pointed at a directory that isn't there would fail every run for a
 * reason that has nothing to do with the change.
 */
export function treesFor(phoenixclawRoot: string, piSourceDir: string): Tree[] {
  const trees: Tree[] = [{ path: phoenixclawRoot, verify: ["npm", "run", "build"] }];
  if (existsSync(path.join(piSourceDir, "package.json"))) {
    trees.push({ path: piSourceDir, verify: ["npm", "run", "build"] });
  }
  return trees;
}

const isGitRepo = (dir: string) => existsSync(path.join(dir, ".git"));

/** Uncommitted changes, as porcelain lines. Empty means clean. */
async function dirtyFiles(tree: string): Promise<string[]> {
  const out = await git(tree, ["status", "--porcelain"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export interface Snapshot {
  tree: string;
  head: string;
}

/**
 * Refuse to start on a tree that already has uncommitted work.
 *
 * Not tidiness: the revert below is `git checkout -- .`, which cannot tell the
 * agent's change from yours. Starting dirty means a failed verify would discard
 * whatever you had in progress, so the run does not start at all.
 */
export async function beforeRun(trees: Tree[]): Promise<{ ok: true; snapshots: Snapshot[] } | { ok: false; reason: string }> {
  const snapshots: Snapshot[] = [];
  for (const { path: tree } of trees) {
    if (!isGitRepo(tree)) continue;
    const dirty = await dirtyFiles(tree);
    if (dirty.length) {
      return {
        ok: false,
        reason:
          `${tree} has uncommitted changes, so this run will not start — a failed verify reverts ` +
          `with "git checkout -- .", which cannot tell your work from the agent's. Commit or stash ` +
          `first.\n${dirty.slice(0, 20).join("\n")}`,
      };
    }
    snapshots.push({ tree, head: await git(tree, ["rev-parse", "HEAD"]) });
  }
  return { ok: true, snapshots };
}

export interface VerifyOutcome {
  tree: string;
  changed: string[];
  built: boolean;
  reverted: boolean;
  output: string;
}

/**
 * Verify whatever the run actually changed, and revert it if it does not build.
 *
 * Only trees that changed are verified: one run touches one codebase, and
 * building the other proves nothing while costing minutes. A tree that moved
 * HEAD is left alone with a note — the routine is told never to commit, so a
 * moved HEAD means something happened that this envelope did not model and
 * should not paper over by reverting.
 */
export async function afterRun(trees: Tree[], snapshots: Snapshot[]): Promise<VerifyOutcome[]> {
  const outcomes: VerifyOutcome[] = [];
  for (const snapshot of snapshots) {
    const tree = trees.find((t) => t.path === snapshot.tree);
    if (!tree) continue;

    const head = await git(tree.path, ["rev-parse", "HEAD"]);
    if (head !== snapshot.head) {
      outcomes.push({
        tree: tree.path,
        changed: [],
        built: false,
        reverted: false,
        output: `HEAD moved (${snapshot.head.slice(0, 8)} → ${head.slice(0, 8)}). Left alone: the routine must never commit, so this is not a change this envelope knows how to undo.`,
      });
      continue;
    }

    const changed = await dirtyFiles(tree.path);
    if (!changed.length) continue;

    let built = false;
    let output = "";
    try {
      const { stdout, stderr } = await run(tree.verify[0], tree.verify.slice(1), {
        cwd: tree.path,
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: 16 << 20,
      });
      built = true;
      output = `${stdout}${stderr}`.trim().slice(-2000);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(-2000) || String(err.message ?? e);
    }

    let reverted = false;
    if (!built) {
      // Untracked files too: a change that added a broken new module would
      // otherwise survive the revert and break the next build instead.
      await git(tree.path, ["checkout", "--", "."]).catch(() => {});
      await git(tree.path, ["clean", "-fd"]).catch(() => {});
      reverted = true;
    }
    outcomes.push({ tree: tree.path, changed, built, reverted, output });
  }
  return outcomes;
}

/** A line for the routine's stored output, so the report says what happened to the tree. */
export function summarise(outcomes: VerifyOutcome[]): string {
  if (!outcomes.length) return "Self-update envelope: nothing changed, nothing to verify.";
  return outcomes
    .map((o) => {
      const name = path.basename(o.tree);
      if (!o.changed.length) return `${name}: ${o.output}`;
      const files = `${o.changed.length} file(s)`;
      if (o.built) return `${name}: ${files} changed, build passed, left uncommitted for review.`;
      return `${name}: ${files} changed, BUILD FAILED, reverted.\n${o.output}`;
    })
    .join("\n");
}
