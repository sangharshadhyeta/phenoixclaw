/**
 * The pruner's contract, from BirdClaw's `llm/pruner.py` docstring and the
 * behaviour its callers rely on. Pure functions, no database — runs standalone.
 *
 *     npm run test:prune
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { keywordPrune } = await import(path.join(here, "..", "dist", "prune.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

ok("short input returned untouched", keywordPrune("tiny", "anything") === "tiny");
ok("empty input is safe", keywordPrune("", "goal") === "");

const long = "x".repeat(500);
ok("no goal falls back to truncation", keywordPrune(long, "", 100).length === 100);
ok("stop-word-only goal falls back to truncation", keywordPrune(long, "the and for", 100).length === 100);

const doc = [
  "The deployment pipeline runs on GitHub Actions.",
  "Cats are unrelated to this document entirely.",
  "Rollback is triggered by re-running the previous workflow.",
  "The weather today is quite mild and pleasant.",
  "Deployment secrets live in the repository settings.",
].join(" ");

const pruned = keywordPrune(doc, "deployment rollback", 160);
ok("keeps relevant sentences", /[Dd]eployment/.test(pruned) && /[Rr]ollback/.test(pruned));
ok("drops irrelevant ones", !/Cats/.test(pruned));
ok("respects the budget", pruned.length <= 200);

const order = keywordPrune(doc, "deployment rollback secrets", 400);
const iPipeline = order.indexOf("pipeline"), iRollback = order.indexOf("Rollback"), iSecrets = order.indexOf("secrets");
ok("emits in original reading order, not by score",
   iPipeline >= 0 && iRollback > iPipeline && iSecrets > iRollback);

ok("never empties non-empty input", keywordPrune(doc, "zzzznothingmatches", 50).length > 0);

const lines = Array.from({ length: 10 }, (_, i) => `line ${i} about widgets and gears`).join("\n");
ok("falls back to line splitting when there are few sentences",
   keywordPrune(lines, "widgets", 120).includes("widgets"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
