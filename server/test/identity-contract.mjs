/**
 * Identity that a person edited on disk.
 *
 * The mirror exists so these documents stay human-readable and git-diffable,
 * and the obvious thing to do with a readable file is edit it. Until now that
 * edit was silently ignored: the graph is the source, so the change sat on disk
 * looking applied and changed nothing. The guard catches a *tool* writing there
 * and redirects it; a person with an editor gets no such message.
 *
 *     npm run test:identity
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);

const home = mkdtempSync(path.join(tmpdir(), "identity-"));
process.env.AGENT_HOME = home;
mkdirSync(path.join(home, ".identity"), { recursive: true });

const { readIdentity, writeIdentity, adoptDiskEdits } = await import(dist("identity.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const mirror = (name) => path.join(home, ".identity", name);
/** Touch a file into the future, so "newer than the node" is unambiguous. */
const makeNewer = (name) => {
  const soon = new Date(Date.now() + 60_000);
  utimesSync(mirror(name), soon, soon);
};

// --- an edit on disk is taken back ----------------------------------------
{
  await writeIdentity("SOUL.md", "# Who you are\n\nThe original.\n");
  ok("the graph holds what was written", (await readIdentity("SOUL.md")).includes("The original"));

  writeFileSync(mirror("SOUL.md"), "# Who you are\n\nEdited by hand.\n");
  makeNewer("SOUL.md");

  const adopted = await adoptDiskEdits();
  ok("the edit is adopted", adopted.includes("SOUL.md"));
  ok("and is what the agent now reads", (await readIdentity("SOUL.md")).includes("Edited by hand"));
}

// --- and only when it is genuinely newer ----------------------------------
{
  await writeIdentity("MEMORY.md", "# What you have learned\n\nFrom the portal.\n");
  // Same content on disk, written by writeIdentity itself: nothing to adopt.
  ok("an untouched mirror is not adopted", !(await adoptDiskEdits()).includes("MEMORY.md"));

  // Content differs but the file is older — the portal wrote last, so the
  // graph is right and the file is simply stale.
  writeFileSync(mirror("MEMORY.md"), "# What you have learned\n\nStale copy.\n");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(mirror("MEMORY.md"), old, old);
  ok("an older mirror is ignored", !(await adoptDiskEdits()).includes("MEMORY.md"));
  ok("and the graph is unchanged", (await readIdentity("MEMORY.md")).includes("From the portal"));
}

// --- adoption is idempotent ------------------------------------------------
{
  // A node must exist first: a mirror with no node at all is
  // migrateIdentityFromDisk's job, not this one, and adopting there would
  // race the migration on a fresh install.
  await writeIdentity("INNER_LIFE.md", "# Your evolving sense of self\n\nAs written by the portal.\n");
  writeFileSync(mirror("INNER_LIFE.md"), "# Your evolving sense of self\n\nA hand-written note.\n");
  makeNewer("INNER_LIFE.md");
  ok("first pass adopts", (await adoptDiskEdits()).includes("INNER_LIFE.md"));
  // writeIdentity has since written the node, so the timestamps now agree.
  ok("second pass does nothing", !(await adoptDiskEdits()).includes("INNER_LIFE.md"));
}

// --- an empty file is not an edit ------------------------------------------
{
  await writeIdentity("PrimaryUser.md", "# Who you work for\n\nSomebody real.\n");
  writeFileSync(mirror("PrimaryUser.md"), "   \n");
  makeNewer("PrimaryUser.md");
  ok("an emptied mirror is not adopted", !(await adoptDiskEdits()).includes("PrimaryUser.md"));
  ok("so identity cannot be deleted by truncating a file",
     (await readIdentity("PrimaryUser.md")).includes("Somebody real"));
}

// --- a mirror with no node is left to the migration ------------------------
// A fresh install has files and no nodes yet; adopting here would race
// migrateIdentityFromDisk, which is the function whose job that is.
{
  writeFileSync(mirror("SELF_CONCEPT.md"), "# What you have concluded\n\nOrphan file.\n");
  makeNewer("SELF_CONCEPT.md");
  ok("a mirror with no node is not adopted", !(await adoptDiskEdits()).includes("SELF_CONCEPT.md"));
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
