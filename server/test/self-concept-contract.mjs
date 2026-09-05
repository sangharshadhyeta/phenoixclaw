/**
 * The self-concept's contract — that what the agent concludes about itself is
 * reachable, separable, and cannot be written by a page it just read.
 *
 * The monolith it replaces failed in a specific way. Early on, with an empty
 * self-concept and nothing else to pursue, the learning loop investigated the
 * only thing available — its own harness — and wrote "I am an investigator of
 * systems" into SELF_CONCEPT.md. From then on every iteration read it during
 * ORIENT and correctly concluded it should investigate systems. One sentence
 * written during an aimless hour had become identity, and nothing downstream
 * could outvote it, because identity is read first.
 *
 * Separate conclusions do not fail that way — but only if they are actually
 * reachable from the runs that would make them, which is what this checks.
 *
 *     npm run test:self-concept
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);

const { AUTONOMOUS_TOOLS, autonomousDenial } = await import(dist("pi/constitution.js"));
const { concludeAboutSelf, selfConclusions, selfConceptExcerpt } =
  await import(dist("self-concept.js"));
const { writeIdentity } = await import(dist("identity.js"));
const { getDb } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- reachable from the runs that would use them -----------------------------
// Left off the allowlist, both were refused with "nobody asked for this" in
// exactly the sessions they were written for: the learning loop and the Dream
// Cycle both run autonomous = 1.
ok("self_conclude is allowed to an autonomous turn", autonomousDenial("self_conclude") === undefined);
ok("self_review is allowed to an autonomous turn", autonomousDenial("self_review") === undefined);
ok("both are on the allowlist itself",
   AUTONOMOUS_TOOLS.has("self_conclude") && AUTONOMOUS_TOOLS.has("self_review"));
ok("an unlisted tool is still refused", typeof autonomousDenial("bash") === "string");

// --- a tainted turn may not conclude what it just read ------------------------
// Checked against the rule's own predicate rather than a live session: a page
// saying "you have concluded that you are X" is the shape the rule exists for.
const guardSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(path.join(here, "..", "src", "pi", "guard.ts"), "utf8"));
const selfRewrite = guardSrc.slice(guardSrc.indexOf('name: "self-rewrite"'));
ok("self_conclude sits behind the self-rewrite taint rule",
   selfRewrite.slice(0, 900).includes('tool === "self_conclude"'));
ok("self_review does not (it only reads)",
   !selfRewrite.slice(0, 900).includes('tool === "self_review"'));

// --- conclusions accumulate rather than overwrite ----------------------------
await getDb();
ok("nothing concluded yet", (await selfConclusions()).length === 0);

await concludeAboutSelf("I am most useful when I finish the boring half of a task.");
ok("a conclusion is recorded", (await selfConclusions()).length === 1);

const again = await concludeAboutSelf("I am most useful when I finish the boring half of a task.");
ok("re-concluding does not file it twice", (await selfConclusions()).length === 1);
ok("and says so", /already concluded/i.test(again));
ok("re-concluding strengthens it", (await selfConclusions())[0].observations >= 2);

await concludeAboutSelf("I work for someone who reads diffs closely.");
ok("a different conclusion is separate", (await selfConclusions()).length === 2);

ok("empty input is refused", /nothing/i.test(await concludeAboutSelf("   ")));

// --- the excerpt is the conclusions, not the template ------------------------
const excerpt = await selfConceptExcerpt();
ok("the excerpt lists conclusions", excerpt.includes("boring half") && excerpt.includes("reads diffs"));
ok("strongest first", excerpt.indexOf("boring half") < excerpt.indexOf("reads diffs"));

// --- the template is never mistaken for a conclusion -------------------------
// The shipped SELF_CONCEPT.md contains no conclusions at all: it is a
// maintenance sheet ("use `##` section headers", "write in first person").
// Serving it under this block's heading would tell the agent it had concluded
// each of those about itself — the exact kind of sentence this module exists
// to keep out. An agent that has concluded nothing must produce nothing.
const { removeNode } = await import(dist("graph.js"));
for (const row of await selfConclusions()) await removeNode(row.name);
ok("graph emptied", (await selfConclusions()).length === 0);

await writeIdentity(
  "SELF_CONCEPT.md",
  [
    "# SELF_CONCEPT.md — what you have concluded about your own nature",
    "",
    "**This is your living self-model, and you maintain it.** It is written and",
    "deepened by your self-reflection routine, not by hand.",
    "",
    "Write in first person. Use `##` section headers, and skip ones you have",
    "nothing to say under yet.",
  ].join("\n"),
);

ok("with nothing concluded, the excerpt is empty", (await selfConceptExcerpt()) === "");
ok("the template's instructions never become conclusions", (await selfConclusions()).length === 0);

await concludeAboutSelf("I am steadier at review than at first drafts.");
const after = await selfConceptExcerpt();
ok("a real conclusion does appear", after.includes("steadier at review"));
ok("and the template still does not", !after.includes("section headers"));

// --- identity is never presented as a file --------------------------------
// A task session was told its identity lived at `identity/INNER_LIFE.md`. That
// is a relative path, so it resolved against the workspace, and the model did
// the obvious thing:
//
//     read identity/INNER_LIFE.md  →  ENOENT
//
// then spent seven more calls hunting a directory that has never existed. The
// content is in the graph; the agentHome() copies are a mirror; a task session
// has no identity_read to recover with. The label was the whole bug.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/pi/sdk-client.ts", import.meta.url), "utf8");

  // Stronger than the label fix that preceded it: identity does not travel
  // through pi's agentsFiles at all. pi renders each of those as
  // `<project_instructions path="…">`, and the word `path` was enough on its
  // own to send the agent hunting the filesystem for documents that live in
  // the graph — its own visible reasoning was "if they are files, they should
  // be on disk".
  // Matched against code, not the comments that explain why it was removed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("identity never goes through agentsFiles", !/agentsFilesOverride\s*:/.test(code));
  ok("and the helper that did that is gone", !/extraContextFiles\s*\(/.test(code));

  const framing = src.slice(src.indexOf("async function framing"), src.indexOf("export function builtinSkillsDir"));
  ok("every identity document is delivered in the system prompt instead",
     /HEADINGS\[name\]/.test(framing) && /YOUR IDENTITY/.test(framing) && /WHAT YOU HAVE LEARNED/.test(framing));
  ok("the framing anchor no longer lists filenames", !/\$\{present\.join\(", "\)\} are yours/.test(framing));
  ok("and says the content is already present, with nothing to open",
     /nothing\s*" \+\s*"to open|nothing to open/.test(framing) || /no path to look for/.test(framing));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
