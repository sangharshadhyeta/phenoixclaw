import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where a symbol is defined. Ports BirdClaw's `tools/code_index.py`.
 *
 * BirdClaw parses Python with `ast` and holds a name → definitions map. That
 * does not transfer: this codebase is TypeScript, and pulling in a TS parser to
 * find where `guardExtension` is declared would be a compiler's worth of
 * dependency for a question a regex answers.
 *
 * So the shape is ported, not the mechanism. What it is *for* survives —
 * "where is this defined" answered in one call instead of three greps and a
 * read — and the cost of being approximate is small: a near miss is a wrong
 * line number in a file the agent then opens anyway, not a wrong answer it
 * acts on.
 *
 * Nothing is cached. BirdClaw builds an index and rebuilds it on demand, which
 * means a stale index between rebuilds; scanning takes milliseconds on a
 * repository this size and is always right, and the agent that just edited a
 * file is exactly the caller who would have been served a stale entry.
 */

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "venv", ".venv",
  "__pycache__", ".mypy_cache", ".ruff_cache", ".next", "coverage", "run-data",
]);

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".h", ".cpp", ".cs",
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_HITS = 25;

export interface SymbolHit {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/**
 * The shapes a definition takes, per language, as anchored patterns.
 *
 * Anchored at the line start (allowing indentation and `export`/modifiers) so
 * a *call* to the symbol does not match — the difference between "where is
 * this defined" and "where is this mentioned", which is the whole value of
 * asking this instead of grepping.
 */
function definitionPatterns(name: string): { kind: string; re: RegExp }[] {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = "^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:abstract\\s+)?(?:async\\s+)?";
  return [
    { kind: "function", re: new RegExp(`${pre}function\\s+\\*?${n}\\b`) },
    { kind: "class", re: new RegExp(`${pre}class\\s+${n}\\b`) },
    { kind: "interface", re: new RegExp(`${pre}interface\\s+${n}\\b`) },
    { kind: "type", re: new RegExp(`${pre}type\\s+${n}\\b`) },
    { kind: "enum", re: new RegExp(`${pre}enum\\s+${n}\\b`) },
    { kind: "const", re: new RegExp(`${pre}(?:const|let|var)\\s+${n}\\b`) },
    // Python and Ruby.
    { kind: "def", re: new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\b`) },
    // Go, Rust, Java-ish.
    { kind: "func", re: new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${n}\\b`) },
    { kind: "func", re: new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${n}\\b`) },
    // A method or property on an object/class body: `name(` or `name =` or `name:`.
    { kind: "member", re: new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${n}\\s*[(=:]`) },
  ];
}

function walk(root: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 20000) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".") continue;
    const full = path.join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out, depth + 1);
    } else if (st.isFile() && SOURCE_EXT.has(path.extname(entry)) && st.size <= MAX_FILE_BYTES) {
      out.push(full);
    }
  }
}

/** Every place `name` looks defined under `root`, most specific kinds first. */
/**
 * Every definition in a tree, rather than the locations of one known name.
 *
 * `findSymbol` answers "where is X" and needs X. This answers "what is here",
 * which is the question worth asking once per project rather than once per
 * lookup — it is what lets the graph hold a project's shape instead of only
 * the facts somebody happened to mention about it.
 *
 * Same regexes, run the other way round: the name is a capture rather than an
 * input. And the same trade — a TypeScript parser would be exact and would be a
 * compiler's worth of dependency for a map whose errors cost a wrong line
 * number in a file the agent opens anyway.
 *
 * Imports are collected alongside, because the edges are most of the value: a
 * list of files is a directory listing, and a list of files that says which
 * ones reach which is a description of the system.
 */
export interface FileOutline {
  file: string;
  symbols: { name: string; kind: string; line: number }[];
  /** Module specifiers this file imports, as written. */
  imports: string[];
}

/** Definitions, captured by name rather than matched against one. */
const DECLARATIONS: { kind: string; re: RegExp }[] = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  // Python, since a workspace is not always TypeScript.
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)/ },
];

const IMPORTS = [
  /^\s*import\s+[^"']*from\s+["']([^"']+)["']/,
  /^\s*import\s+["']([^"']+)["']/,
  /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/,
];

/**
 * Files worth outlining from one tree.
 *
 * Capped, and the cap is the point: a repository with ten thousand source files
 * would otherwise put ten thousand nodes in a graph that is meant to hold what
 * the agent has *learned*. The outline is a sketch of a project, not an index
 * of it — anything more specific is what `findSymbol` and `grep` are for.
 */
const MAX_OUTLINE_FILES = 200;
const MAX_SYMBOLS_PER_FILE = 40;

export function outlineProject(root: string): FileOutline[] {
  const files: string[] = [];
  walk(root, files);

  const out: FileOutline[] = [];
  for (const file of files.slice(0, MAX_OUTLINE_FILES)) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }

    const symbols: FileOutline["symbols"] = [];
    const imports = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { kind, re } of DECLARATIONS) {
        const m = re.exec(line);
        if (m?.[1]) {
          if (symbols.length < MAX_SYMBOLS_PER_FILE) symbols.push({ name: m[1], kind, line: i + 1 });
          break;
        }
      }
      if (!line.includes("import") && !line.startsWith("from")) continue;
      for (const re of IMPORTS) {
        const m = re.exec(line);
        // Relative specifiers are noise across projects — "./guard" says
        // nothing on its own. Packages are what a dependency edge is about.
        if (m?.[1] && !m[1].startsWith(".")) {
          imports.add(m[1]);
          break;
        }
      }
    }

    if (symbols.length || imports.size) {
      out.push({ file: path.relative(root, file), symbols, imports: [...imports] });
    }
  }
  return out;
}

export function findSymbol(name: string, root: string): SymbolHit[] {
  const clean = name.trim();
  if (!clean || !/^[A-Za-z_$][\w$]*$/.test(clean)) return [];

  const patterns = definitionPatterns(clean);
  const files: string[] = [];
  walk(root, files);

  const hits: SymbolHit[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Cheap reject before the pattern loop — most lines never mention it.
      if (!line.includes(clean)) continue;
      for (const { kind, re } of patterns) {
        if (re.test(line)) {
          hits.push({ file: path.relative(root, file), line: i + 1, kind, text: line.trim().slice(0, 160) });
          break;
        }
      }
      if (hits.length >= MAX_HITS) return rank(hits);
    }
  }
  return rank(hits);
}

/**
 * A `member` match is the loosest pattern and the likeliest false positive —
 * `foo:` in an object literal looks like a method. Sorted last so the real
 * declaration is what the reader sees first.
 */
const rank = (hits: SymbolHit[]): SymbolHit[] =>
  hits.sort((a, b) => Number(a.kind === "member") - Number(b.kind === "member"));
