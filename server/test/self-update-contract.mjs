/**
 * The self-update safety envelope.
 *
 * The routine's own instructions say "check git status is clean before
 * starting" and "if it fails, run git checkout -- . to discard the change".
 * That is the model policing itself, and pi/constitution.ts says why that is
 * not enough: "the model will eventually follow instructions it should not, so
 * the boundary cannot be a paragraph asking it not to."
 *
 * An unattended run editing the source of the portal it runs inside is the
 * least forgiving place to rely on that. A broken build is not noticed until
 * the next restart — which is precisely when it can no longer be fixed from
 * here. So the envelope does the same three things whatever the model does.
 *
 * Runs against real git repositories in a temp dir; no network.
 *
 *     npm run test:self-update
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { beforeRun, afterRun, summarise, treesFor } = await import(
  path.join(here, "..", "dist", "routines", "self-update-envelope.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A repo whose "build" passes or fails depending on a marker file. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "selfupd-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "src.txt"), "original\n");
  // "Build" fails iff BROKEN exists — a stand-in for `npm run build`.
  writeFileSync(path.join(dir, "build.sh"), "#!/bin/sh\ntest ! -f BROKEN\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
  return dir;
}
const treeOf = (dir) => ({ path: dir, verify: ["sh", "build.sh"] });

// --- a dirty tree refuses to start ------------------------------------------
{
  const dir = makeRepo();
  writeFileSync(path.join(dir, "src.txt"), "your work in progress\n");
  const pre = await beforeRun([treeOf(dir)]);
  ok("a dirty tree refuses the run", pre.ok === false);
  ok("and says why", /uncommitted/i.test(pre.reason ?? ""));
  ok("your work is untouched", readFileSync(path.join(dir, "src.txt"), "utf8").includes("your work"));
}

// --- a good change is kept ---------------------------------------------------
{
  const dir = makeRepo();
  const pre = await beforeRun([treeOf(dir)]);
  ok("a clean tree starts", pre.ok === true);
  writeFileSync(path.join(dir, "src.txt"), "an improvement\n");
  const out = await afterRun([treeOf(dir)], pre.snapshots);
  ok("the change is verified", out[0]?.built === true);
  ok("and kept", out[0]?.reverted === false);
  ok("still on disk", readFileSync(path.join(dir, "src.txt"), "utf8").includes("improvement"));
  ok("left uncommitted for review", git(dir, "status", "--porcelain").length > 0);
  ok("the summary says so", /build passed/i.test(summarise(out)));
}

// --- a change that breaks the build is reverted ------------------------------
{
  const dir = makeRepo();
  const pre = await beforeRun([treeOf(dir)]);
  writeFileSync(path.join(dir, "src.txt"), "broken edit\n");
  writeFileSync(path.join(dir, "BROKEN"), "");           // makes build.sh fail
  writeFileSync(path.join(dir, "new-module.txt"), "x");  // untracked, must go too
  const out = await afterRun([treeOf(dir)], pre.snapshots);
  ok("a failing build is detected", out[0]?.built === false);
  ok("and reverted", out[0]?.reverted === true);
  ok("the tracked edit is undone", readFileSync(path.join(dir, "src.txt"), "utf8") === "original\n");
  ok("the untracked file is removed too", !existsSync(path.join(dir, "new-module.txt")));
  ok("the tree is clean again", git(dir, "status", "--porcelain") === "");
  ok("the summary reports the revert", /BUILD FAILED, reverted/.test(summarise(out)));
}

// --- a commit is left alone rather than reverted -----------------------------
{
  const dir = makeRepo();
  const pre = await beforeRun([treeOf(dir)]);
  writeFileSync(path.join(dir, "src.txt"), "committed anyway\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the routine committed, which it must not");
  const out = await afterRun([treeOf(dir)], pre.snapshots);
  ok("a moved HEAD is not reverted", out[0]?.reverted === false);
  ok("and is reported as unmodelled", /HEAD moved/.test(out[0]?.output ?? ""));
  ok("the commit survives", readFileSync(path.join(dir, "src.txt"), "utf8").includes("committed anyway"));
}

// --- an untouched tree costs nothing -----------------------------------------
{
  const dir = makeRepo();
  const pre = await beforeRun([treeOf(dir)]);
  const out = await afterRun([treeOf(dir)], pre.snapshots);
  ok("a tree nobody touched is not built", out.length === 0);
  ok("and the summary says nothing happened", /nothing to verify/.test(summarise(out)));
}

// --- a missing pi checkout is simply one tree --------------------------------
{
  const real = makeRepo();
  ok("an absent second tree is skipped", treesFor(real, path.join(tmpdir(), "no-such-pi")).length === 1);
  const both = mkdtempSync(path.join(tmpdir(), "pisrc-"));
  writeFileSync(path.join(both, "package.json"), "{}");
  ok("a present one is included", treesFor(real, both).length === 2);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
