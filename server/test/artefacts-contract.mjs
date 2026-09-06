/**
 * Where finished work lives, once, instead of once per session.
 *
 * Sessions may only write inside their own workspace, so every run that
 * produced a document produced a *new* one: three runs at the same module left
 * three geometry.mjs files in three throwaway directories, each written from
 * scratch. The knowledge carried forward; the artefact never did.
 *
 * This is a deliberate hole in the workspace boundary — the same shape as the
 * skills directory, which has always worked this way — so most of what follows
 * is about the edges of it: what counts as inside the store, what a second run
 * adopts, and what happens when the sidecar no longer matches the file.
 *
 *     npm run test:artefacts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const store = mkdtempSync(path.join(tmpdir(), "artefacts-"));
process.env.ARTEFACTS_DIR = store;

const here = path.dirname(fileURLToPath(import.meta.url));
const a = await import(path.join(here, "..", "dist", "artefacts.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- what is inside the store ----------------------------------------------
{
  ok("a file in the store is recognised", a.isArtefact(path.join(store, "x", "file.md")));
  ok("a file outside it is not", !a.isArtefact("/workspaces/session-abc/file.md"));
  ok("the store's own path is not an artefact", !a.isArtefact(store));
  // The check must not be a prefix comparison: /tmp/artefacts-x-evil is not
  // inside /tmp/artefacts-x.
  ok("a sibling directory with the same prefix is not inside it", !a.isArtefact(`${store}-evil/file.md`));
  ok("and neither is a path that climbs out", !a.isArtefact(path.join(store, "..", "escape.md")));
}

// --- the same request reaches the same place --------------------------------
{
  // The name comes from the file, not from the words of the request. A slug of
  // the request's significant words looked right and was not: "write
  // geometry.mjs with area and perimeter" and "write a geometry.mjs exporting
  // perimeter and area" differ by one word no stop-list catches, and landed in
  // different directories — the exact failure the store exists to prevent,
  // reintroduced by its own naming. Which file a run actually opens is decided
  // by prior-work recall, which answers the semantic question properly.
  const one = a.workSlug("Write geometry.mjs with area and perimeter", "geometry.mjs");
  const two = a.workSlug("Write a geometry.mjs exporting perimeter and area", "geometry.mjs");
  ok("wording does not change where work lands", one === two);

  const other = a.workSlug("Write a deployment guide for the API", "guide.md");
  ok("a different file lands somewhere else", other !== one);
  ok("and the name is legible in a directory listing", one === "geometry");

  ok("the artefact keeps its own filename", path.basename(a.artefactPath("write a guide", "guide.md")) === "guide.md");
  ok("and sits inside the store", a.isArtefact(a.artefactPath("write a guide", "guide.md")));
  ok("a nameless artefact still gets a home", a.workSlug("please write the thing", "").length > 0);
  // A path in the request must not become directories in the store.
  ok("a slug is a single directory name", !a.workSlug("write ../../etc/passwd now", "a/b.md").includes("/"));
}

// --- the plan that travels with the file ------------------------------------
{
  const file = a.artefactPath("write the guide", "guide.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "x".repeat(100));
  a.writeArtefactPlan(file, {
    goal: "write the guide",
    updatedAt: new Date().toISOString(),
    sections: [{ description: "intro", status: "done", result: "50 chars @0-50" }],
  });

  ok("the sidecar is written beside the artefact", existsSync(`${file}.plan.json`));
  const back = a.readArtefactPlan(file);
  ok("and reads back", back?.sections?.[0]?.description === "intro");

  // A plan whose spans no longer fit the file is worse than none: read_section
  // would return confidently wrong slices and write_revise would overwrite the
  // wrong bytes.
  writeFileSync(file, "tiny");
  ok("a plan that no longer fits the file is refused", a.readArtefactPlan(file) === undefined);

  writeFileSync(`${file}.plan.json`, "{not json");
  ok("an unreadable sidecar is refused rather than thrown", a.readArtefactPlan(file) === undefined);
  ok("no sidecar at all is simply nothing", a.readArtefactPlan(path.join(store, "nothing.md")) === undefined);
}

// --- history ----------------------------------------------------------------
{
  ok("the store becomes a repository", a.ensureArtefactRepo() && existsSync(path.join(store, ".git")));

  const file = a.artefactPath("write the notes", "notes.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "first section\n");
  a.commitArtefact(file, "wrote intro");
  writeFileSync(file, "first section\nsecond section\n");
  a.commitArtefact(file, "wrote body");

  const log = a.artefactHistory(file);
  ok("each section is its own commit", log.length === 2);
  ok("newest first", /wrote body/.test(log[0]) && /wrote intro/.test(log[1]));
  ok("with a date", /\d{4}-\d{2}-\d{2}/.test(log[0]));

  // Scoped to the artefact: another session writing a different one in the
  // same repository must not appear under this run's message.
  const other = a.artefactPath("write something else entirely", "other.md");
  mkdirSync(path.dirname(other), { recursive: true });
  writeFileSync(other, "unrelated\n");
  a.commitArtefact(file, "wrote conclusion");
  ok("an unrelated file is not swept into this commit",
     a.artefactHistory(other).length === 0 && /unrelated/.test(readFileSync(other, "utf8")));

  ok("history of a file outside the store is empty", a.artefactHistory("/workspaces/session-x/f.md").length === 0);
  // Committing something outside the store must be a no-op, not an error.
  let threw = false;
  try { a.commitArtefact("/workspaces/session-x/f.md", "nope"); } catch { threw = true; }
  ok("committing outside the store does nothing quietly", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
