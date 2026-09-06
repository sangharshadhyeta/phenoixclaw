/**
 * What this agent has already built, so the next attempt improves on it.
 *
 * Every plan run started from an empty file in a fresh workspace while the last
 * run's output sat on disk in another one, unreferenced. Asked the same thing
 * twice, the agent wrote it twice — and the second time was not better than the
 * first, because the first was not in front of it.
 *
 * The failure mode to guard against is the opposite one: handing a run its own
 * half-written file back as "prior work" to improve on.
 *
 *     npm run test:prior
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { priorWork, priorWorkFrom, priorWorkBlock } = await import(path.join(here, "..", "dist", "pi", "prior-work.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const dir = mkdtempSync(path.join(tmpdir(), "prior-"));
const earlier = path.join(dir, "old-session", "geometry.mjs");
const { mkdirSync } = await import("node:fs");
mkdirSync(path.dirname(earlier), { recursive: true });
writeFileSync(earlier, `${"// filler\n".repeat(80)}export function area(r) { return Math.PI * r * r; }\n`);

const node = (name, summary) => ({ name, summary, type: "episode" });

// --- finding it -------------------------------------------------------------
{
  const hits = [
    node("some unrelated concept", "about something else"),
    node(`artefact:${earlier}`, "Write geometry.mjs — area and perimeter\n\nWritten to it. 2 sections"),
  ];
  const found = priorWorkFrom(hits, path.join(dir, "new-session"));
  ok("an earlier artefact is found among ordinary recall hits", found?.file === earlier);
  ok("with what it was for", /area and perimeter/.test(found?.goal ?? ""));
  ok("and its actual content, read from disk now", /Math\.PI/.test(found?.content ?? ""));

  // The one that would be actively harmful: a run offered its own file back.
  const own = priorWorkFrom(hits, path.dirname(earlier));
  ok("a run is not offered its own workspace as prior work", own === undefined);

  ok("nothing to find is not an error", priorWorkFrom([node("x", "y")], dir) === undefined);
}

// --- a pointer, not a copy --------------------------------------------------
{
  const gone = path.join(dir, "old-session", "deleted.md");
  const found = priorWorkFrom([node(`artefact:${gone}`, "Write the guide")], path.join(dir, "new"));
  ok("an artefact that no longer exists is still reported", found?.file === gone);
  ok("but with no content invented for it", found?.content === undefined);

  const block = priorWorkBlock(found);
  ok("and the block says it is gone", /no longer on disk/.test(block));
  ok("while still noting the attempt happened", /you have been here before/.test(block));
}

// --- how it is put ----------------------------------------------------------
{
  ok("no prior work says nothing at all", priorWorkBlock(undefined) === "");

  const block = priorWorkBlock({ file: "/w/old/guide.md", goal: "Write the deployment guide", content: "x".repeat(3000) });
  ok("the file is named", /\/w\/old\/guide\.md/.test(block));
  ok("and what it was for", /deployment guide/.test(block));
  ok("it is told to read the whole thing before planning", /Read it in full before you plan/.test(block));
  ok("improving is argued for, not just asserted", /better than writing it again from/.test(block));
  ok("and it may be rejected", /say so and start/.test(block) && /not something you owe/.test(block));
  ok("only the end of a long file is shown", block.length < 3000);
}

// --- failure paths ----------------------------------------------------------
{
  ok("an empty goal looks nothing up", (await priorWork("", dir, { recall: async () => { throw new Error("should not ask"); } })) === undefined);
  ok("a recall that throws is survivable",
     (await priorWork("something", dir, { recall: async () => { throw new Error("graph is down"); } })) === undefined);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
