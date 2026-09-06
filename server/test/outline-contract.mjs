/**
 * Reading a codebase's shape into memory.
 *
 * `find_symbol` answers "where is X" and needs X. This answers "what is here",
 * which is the question worth asking once per project — it is what lets the
 * graph hold a project's shape rather than only the facts somebody happened to
 * mention about it.
 *
 *     npm run test:outline
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { outlineProject } = await import(path.join(here, "..", "dist", "code-index.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const root = mkdtempSync(path.join(tmpdir(), "outline-"));
mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });

writeFileSync(
  path.join(root, "src", "guard.ts"),
  [
    'import { readFileSync } from "node:fs";',
    'import { helper } from "./local-helper";',
    'import express from "express";',
    "",
    "export interface Rule { name: string }",
    "export class Guard {}",
    "export function guardExtension(id: string) { return id; }",
    "const CONSTANT = 1;",
    "guardExtension('call site, not a definition');",
  ].join("\n"),
);
writeFileSync(
  path.join(root, "src", "loop.py"),
  ["import requests", "", "class Loop:", "    def run(self):", "        pass"].join("\n"),
);
writeFileSync(path.join(root, "node_modules", "junk", "index.ts"), "export function junk() {}");

const outline = outlineProject(root);

// --- what it finds ---------------------------------------------------------
{
  const guard = outline.find((f) => f.file.endsWith("guard.ts"));
  ok("a source file is outlined", Boolean(guard));

  const names = guard.symbols.map((s) => s.name);
  ok("a function is found", names.includes("guardExtension"));
  ok("a class is found", names.includes("Guard"));
  ok("an interface is found", names.includes("Rule"));
  ok("with the kind attached",
     guard.symbols.find((s) => s.name === "Guard").kind === "class");
  ok("and the line it is on",
     guard.symbols.find((s) => s.name === "guardExtension").line === 7);

  // The distinction that makes this worth having over grep.
  ok("a call site is not a definition",
     guard.symbols.filter((s) => s.name === "guardExtension").length === 1);
}

// --- dependencies ----------------------------------------------------------
{
  const guard = outline.find((f) => f.file.endsWith("guard.ts"));
  ok("a package import is recorded", guard.imports.includes("express"));
  ok("and a node builtin", guard.imports.includes("node:fs"));
  // "./local-helper" says nothing outside this file; packages are what a
  // dependency edge is about.
  ok("a relative import is not", !guard.imports.some((i) => i.startsWith(".")));
}

// --- other languages, and what is skipped ----------------------------------
{
  const py = outline.find((f) => f.file.endsWith("loop.py"));
  ok("Python is outlined too", Boolean(py));
  ok("its class is found", py.symbols.some((s) => s.name === "Loop" && s.kind === "class"));
  ok("and its method", py.symbols.some((s) => s.name === "run" && s.kind === "function"));
  ok("its import is recorded", py.imports.includes("requests"));

  ok("node_modules is not walked", !outline.some((f) => f.file.includes("node_modules")));
}

// --- and it must not run away on a large tree -------------------------------
{
  const big = mkdtempSync(path.join(tmpdir(), "outline-big-"));
  for (let i = 0; i < 260; i++) {
    writeFileSync(path.join(big, `file${i}.ts`), `export function fn${i}() {}`);
  }
  const capped = outlineProject(big);
  ok("a large tree is capped", capped.length <= 200);
  ok("and still returns something useful", capped.length > 0);
}

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail > 0 ? 1 : 0);
