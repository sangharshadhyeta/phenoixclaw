/**
 * The symbol finder's contract, from BirdClaw's `tools/code_index.py`.
 *
 *     npm run test:symbols
 *
 * Run against this repo's own server/src, so the assertions are about real
 * declarations rather than a fixture that could drift from how the code is
 * actually written. The distinction it has to get right is definition versus
 * mention — otherwise it is a slower grep.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { findSymbol } = await import(path.join(here, "..", "dist", "code-index.js"));
const SRC = path.join(here, "..", "src");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const guard = findSymbol("guardExtension", SRC);
ok("finds an exported function", guard.some((h) => h.file.endsWith("guard.ts") && h.kind === "function"));
ok("reports a plausible line number", guard[0]?.line > 1);

ok("finds an interface", findSymbol("TaskRow", SRC).some((h) => h.kind === "interface"));
ok("finds a type alias", findSymbol("NodeType", SRC).some((h) => h.kind === "type"));
ok("finds a const", findSymbol("USER_CATEGORIES", SRC).some((h) => h.kind === "const"));

/**
 * The one that matters. `keywordPrune` is defined once and called from several
 * files; a grep returns every call site.
 */
const pruneHits = findSymbol("keywordPrune", SRC);
ok("definitions only, not call sites", pruneHits.every((h) => /function|const|member/.test(h.kind)));
ok("finds the real definition", pruneHits.some((h) => h.file.endsWith("prune.ts") && h.kind === "function"));

ok("unknown symbol returns nothing", findSymbol("definitelyNotDefinedAnywhere", SRC).length === 0);
ok("empty name is safe", findSymbol("", SRC).length === 0);
ok("rejects a non-identifier", findSymbol("../../etc/passwd", SRC).length === 0);
ok("rejects a regex-ish name", findSymbol("a.*b", SRC).length === 0);

// node_modules and dist are skipped, or every answer would be drowned in them.
ok("skips node_modules and dist", findSymbol("upsertNode", SRC).every((h) => !/node_modules|dist\//.test(h.file)));

// The looser `member` pattern must never outrank a real declaration.
const ranked = findSymbol("upsertNode", SRC);
const firstMember = ranked.findIndex((h) => h.kind === "member");
const lastReal = ranked.map((h) => h.kind !== "member").lastIndexOf(true);
ok("real declarations rank above member matches", firstMember === -1 || lastReal < firstMember);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
