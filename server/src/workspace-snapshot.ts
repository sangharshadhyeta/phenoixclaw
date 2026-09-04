import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A lightweight, always-current picture of a workspace — ports BirdClaw's
 * workspace.py. BirdClaw calls this fresh every turn rather than caching it
 * (an mtime-sorted directory walk, cheap enough not to bother), so this is a
 * live read-time function, not graph-backed — same as there.
 *
 * BirdClaw's snapshot also carries pending TaskList steps; that half isn't
 * ported here since Phoenixclaw has no equivalent per-workspace task-file
 * concept to read from — this is the file-system half only.
 */

const RECENT_FILE_COUNT = 8;
const MAX_DEPTH = 4;
const CHAR_CAP = 600;
const EXCLUDED_DIRS = new Set(["__pycache__", "node_modules", ".git", "venv", ".venv", "dist", "build"]);

function recentModifiedFiles(root: string, maxFiles = RECENT_FILE_COUNT, maxDepth = MAX_DEPTH): string[] {
  const entries: [number, string][] = [];

  const walk = (dir: string, depth: number) => {
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;
        walk(full, depth + 1);
      } else if (st.isFile()) {
        entries.push([st.mtimeMs, full]);
      }
    }
  };

  walk(root, 0);
  entries.sort((a, b) => b[0] - a[0]);
  return entries.slice(0, maxFiles).map(([, p]) => p);
}

export interface WorkspaceSnapshot {
  cwd: string;
  recentFiles: string[];
}

export function snapshot(cwd: string): WorkspaceSnapshot {
  return { cwd, recentFiles: recentModifiedFiles(cwd) };
}

/** Compact text block for system-prompt injection. Truncated to CHAR_CAP, never padded. */
export function render(cwd: string): string {
  const snap = snapshot(cwd);
  const parts = [`Working directory: ${snap.cwd}`];
  if (snap.recentFiles.length) {
    parts.push("Recent files:\n" + snap.recentFiles.map((f) => `  ${f}`).join("\n"));
  }
  const rendered = parts.join("\n\n");
  return rendered.length > CHAR_CAP ? `${rendered.slice(0, CHAR_CAP)}\n[workspace snapshot truncated]` : rendered;
}
