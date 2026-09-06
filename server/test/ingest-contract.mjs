/**
 * What reaches memory without a model: page cleaning and the regex NER pass.
 *
 * Both exist because the model path is the good one and is not free — a call
 * per chunk, seconds at a time, and nothing at all when the server is down. A
 * portal with no extraction server should still accumulate the paths, URLs and
 * error types it has seen, and should not fill its page store with navigation
 * menus.
 *
 *     npm run test:ingest
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);
const { cleanPageText } = await import(dist("pi/web-tools.js"));
const { ingestEntities } = await import(dist("ingest.js"));
const { getNode, nodesByType } = await import(dist("graph.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- page cleaning ---------------------------------------------------------
{
  const page = [
    "Skip to content",
    "Home",
    "Docs",
    "Blog",
    "Accept all cookies",
    "The deployment pipeline runs on GitHub Actions and rolls back by re-running",
    "the previous workflow. Rollbacks take about ninety seconds.",
    "Home",
    "Docs",
    "Blog",
    "© 2026 Example Ltd",
    "All rights reserved",
  ].join("\n");

  const cleaned = cleanPageText(page);
  ok("the prose survives", /deployment pipeline runs on GitHub Actions/.test(cleaned));
  ok("and all of it", /ninety seconds/.test(cleaned));
  ok("a cookie notice goes", !/Accept all cookies/.test(cleaned));
  ok("skip-to-content goes", !/Skip to content/i.test(cleaned));
  ok("a copyright line goes", !/All rights reserved/.test(cleaned));
  ok("repeated navigation goes", !/^Docs$/m.test(cleaned));

  // A page that is mostly menu would be gutted, so cleaning stands down —
  // losing a real sentence is worse than keeping a menu item.
  const nav = ["Home", "Docs", "Blog", "About", "Contact", "Home", "Docs"].join("\n");
  ok("a page that is nearly all furniture is left alone", cleanPageText(nav) === nav);

  ok("empty input is safe", cleanPageText("") === "");
  const prose = "A single paragraph that says something worth keeping about the system.";
  ok("prose alone is untouched", cleanPageText(prose) === prose);
}

// --- the regex pass --------------------------------------------------------
{
  const text = [
    "The failure is in server/src/pi/guard.ts and it throws TypeError on boot.",
    "See https://example.com/docs/guard for the write-up.",
    "It shows up as ENOENT when the path is missing.",
  ].join("\n");

  const written = await ingestEntities(text, "test-source", undefined);
  ok("entities are found without a model", written >= 4);

  ok("a file path is recorded", Boolean(await getNode("server/src/pi/guard.ts")));
  ok("a URL is recorded", Boolean(await getNode("https://example.com/docs/guard")));
  ok("an error type is recorded", Boolean(await getNode("TypeError")));
  ok("and an errno-style code", Boolean(await getNode("ENOENT")));

  const node = await getNode("server/src/pi/guard.ts");
  ok("recorded weakly — appearing in text is thin evidence", node.confidence <= 0.3);
  ok("with its source kept", (node.sources ?? []).includes("test-source"));

  // Prose must not be mined for nouns: cheap noise compounds, and a hundred
  // junk nodes cost more in recall quality than they save in extraction cost.
  const before = (await nodesByType("concept", 500)).length;
  await ingestEntities("We talked about the weather and it was quite pleasant today.", "chatter");
  ok("ordinary prose yields nothing", (await nodesByType("concept", 500)).length === before);

  // One directory listing must not flood the graph.
  const many = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`).join(" ");
  const flood = await ingestEntities(many, "listing");
  ok("a long listing is capped", flood <= 8);

  ok("empty input is safe", (await ingestEntities("", "nothing")) === 0);
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
