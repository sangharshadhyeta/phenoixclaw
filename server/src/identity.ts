import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./agent.js";
import { getNode, upsertNode } from "./graph.js";

/**
 * Identity, sourced from the graph.
 *
 * SOUL.md / PrimaryUser.md / MEMORY.md / SELF_CONCEPT.md / INNER_LIFE.md used
 * to be read straight off disk, and only when a session's cwd happened to be
 * agentHome() — which is why a task session (cwd = the workspace being worked
 * on) never saw any of it and would introduce itself as bare "pi". The graph
 * has no cwd: every session can ask it "who am I" the same way, task or chat.
 *
 * Each file is one `anchor` node (graph.ts already freezes anchors against
 * casual overwrite; a write here always passes confidence 1.0, the same
 * "deliberate correction" signal graph.ts requires to update one). Disk is
 * now a mirror only — kept so the existing content stays human-readable and
 * git-diffable, and so a graph.duckdb wipe has something to recover from —
 * never read as the primary source once the graph has the node.
 *
 * CONSTITUTION.md is deliberately not here — see agent-setup.ts's
 * CONSTITUTION_FILE comment. It stays fixed, disk-only, human-edited.
 */

export const IDENTITY_FILES = [
  "SOUL.md",
  "PrimaryUser.md",
  "MEMORY.md",
  "SELF_CONCEPT.md",
  "INNER_LIFE.md",
] as const;
export type IdentityFile = (typeof IDENTITY_FILES)[number];

const KEY: Record<IdentityFile, string> = {
  "SOUL.md": "identity:soul",
  "PrimaryUser.md": "identity:primary_user",
  "MEMORY.md": "identity:memory",
  "SELF_CONCEPT.md": "identity:self_concept",
  "INNER_LIFE.md": "identity:inner_life",
};

const isIdentityFile = (name: string): name is IdentityFile =>
  (IDENTITY_FILES as readonly string[]).includes(name);

const diskPath = (name: string) => path.join(agentHome(), name);

function readDisk(name: string): string {
  try {
    return existsSync(diskPath(name)) ? readFileSync(diskPath(name), "utf8") : "";
  } catch {
    return "";
  }
}

function writeDisk(name: string, content: string): void {
  try {
    writeFileSync(diskPath(name), content, "utf8");
  } catch {
    // Best effort — the graph write already happened and is what every
    // session actually reads; disk is a convenience mirror, not load-bearing.
  }
}

/**
 * One-time, idempotent: seed the graph from whatever is already on disk, so
 * the SELF_CONCEPT/INNER_LIFE work a running agent has already accrued
 * survives the migration instead of starting blank. Never overwrites a graph
 * node that already has content — disk is only consulted for a node the
 * graph doesn't have yet.
 */
export async function migrateIdentityFromDisk(): Promise<void> {
  for (const name of IDENTITY_FILES) {
    const existing = await getNode(KEY[name]);
    if (existing?.summary) continue;
    const disk = readDisk(name);
    if (disk) await upsertNode(KEY[name], "anchor", disk, 1.0);
  }
}

/**
 * Stop the identity documents describing themselves as files.
 *
 * They were files once. They are anchor nodes now, and the copies in
 * agentHome() are a mirror — but the *content* still opened with
 * "# MEMORY.md — what you have learned" and "**This file is your long-term
 * memory**". A model holding that text and a `read` tool does the obvious
 * thing, and in a task session, whose cwd is a workspace, there is no such
 * file to find:
 *
 *     read PrimaryUser.md  ->  ENOENT
 *     read MEMORY.md       ->  ENOENT
 *     "I don't know your favorite colour yet."
 *
 * It had the answer in context and went looking for a file instead. The
 * templates in agent-setup.ts no longer say it; this repairs the agents that
 * were already seeded from the old ones, since a graph anchor is written once
 * and would otherwise carry the old wording forever.
 *
 * Rewrites only the two self-referential forms, leaving everything a person or
 * the agent has since written untouched. Idempotent: after one pass there is
 * nothing left to match.
 */
export async function stopIdentityNamingFiles(): Promise<number> {
  const headings: Record<IdentityFile, string> = {
    "SOUL.md": "# Who you are",
    "PrimaryUser.md": "# Who you work for",
    "MEMORY.md": "# What you have learned",
    "SELF_CONCEPT.md": "# What you have concluded about your own nature",
    "INNER_LIFE.md": "# Your evolving sense of self, built from actual work",
  };

  let repaired = 0;
  for (const name of IDENTITY_FILES) {
    const current = await readIdentity(name);
    if (!current) continue;
    const fixed = current
      // "# MEMORY.md — what you have learned" -> the same words, no filename.
      .replace(new RegExp(`^#\\s*${name.replace(".", "\\.")}\\s*—?\\s*(.*)$`, "m"), (_m, rest) =>
        rest ? `# ${String(rest).charAt(0).toUpperCase()}${String(rest).slice(1)}` : headings[name],
      )
      // "**This file is ...**" -> "**This is ...**"
      .replace(/\*\*This file (is|describes)\b/g, "**This $1")
      .replace(/\bthis file is theirs to write\b/gi, "this part is theirs to write")
      .replace(/\bit belongs in MEMORY\.md\b/gi, "it belongs in your long-term memory")
      .replace(/\bTo change how you behave, edit this file\.\s*/g, "To change how you behave, use identity_update.\n");
    if (fixed !== current) {
      await writeIdentity(name, fixed);
      repaired++;
    }
  }
  return repaired;
}

/** Graph first; disk is only a fallback for the instant before migration has run. */
export async function readIdentity(name: IdentityFile): Promise<string> {
  const node = await getNode(KEY[name]);
  if (node?.summary) return node.summary;
  return readDisk(name);
}

export async function writeIdentity(name: string, content: string): Promise<void> {
  if (!isIdentityFile(name)) throw new Error(`"${name}" is not one of the agent's identity files`);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  await upsertNode(KEY[name], "anchor", body, 1.0);
  writeDisk(name, body);
}

export async function isIdentityInitialised(): Promise<boolean> {
  for (const name of IDENTITY_FILES) {
    if (!(await readIdentity(name))) return false;
  }
  return true;
}

export async function identityStatus() {
  const files = await Promise.all(
    IDENTITY_FILES.map(async (name) => {
      const content = await readIdentity(name);
      return { name, exists: content.length > 0, content };
    }),
  );
  return { home: agentHome(), initialised: files.every((f) => f.exists), files };
}
