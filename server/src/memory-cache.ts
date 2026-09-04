import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { deleteNodesByCategory, getNode, upsertNode, type NodeRow } from "./graph.js";

/**
 * Tool-result memoization over the graph — ports BirdClaw's tool_cache.py.
 * Not a pi extension itself: a plain module for whatever runs tool calls to
 * consult before doing the work, and to write into after. pi/cached-tools.ts
 * is that caller; see it for why the cache has to sit inside a tool override
 * rather than in a `tool_call` hook. `bash`/`write`/`edit` are never cached,
 * same as BirdClaw's split. No web-fetch tool is registered in this pi setup
 * yet, so BirdClaw's TTL-based web half isn't ported — the file-mtime half is
 * the whole of it for now.
 *
 * `read` and `ls` only, though BirdClaw also cached its equivalents of
 * `grep`/`find`. Freshness here is one path's mtime, and that is only a
 * truthful answer when the call read exactly that path: a grep walks a whole
 * tree, and the root directory's mtime does not move when a file three
 * levels down is edited, so a cached grep would keep serving results that
 * silently no longer match the code. pi's own in-process withToolCache draws
 * the same line for the same reason, wrapping read and ls and leaving grep
 * and find alone.
 */

const CACHEABLE_TOOLS = new Set(["read", "ls"]);

const argsHash = (toolName: string, args: Record<string, unknown>): string =>
  createHash("sha256")
    .update(JSON.stringify({ tool: toolName, args }, Object.keys(args).sort()))
    .digest("hex")
    .slice(0, 16);

const nodeName = (toolName: string, hash: string) => `tool_cache:${toolName}:${hash}`;

/**
 * The path a cacheable tool's arguments point at — the one thing whose mtime
 * freshness is checked against.
 *
 * Absolute only. A relative path would be resolved by `statSync` against the
 * portal process's own cwd rather than the session's, so freshness would be
 * checked against a different file than the tool read — or, more often, one
 * that does not exist. It would also key two sessions' reads of their own
 * `src/index.ts` to the same cache entry. Callers pass an absolute path
 * (pi/cached-tools.ts resolves it against the session cwd first); anything
 * else is treated as uncacheable rather than silently mis-keyed.
 */
const targetPath = (args: Record<string, unknown>): string | undefined =>
  typeof args.path === "string" && isAbsolute(args.path) ? args.path : undefined;

function isFresh(node: NodeRow, args: Record<string, unknown>): boolean {
  const path = targetPath(args);
  if (!path) return false; // Nothing to verify against — assume stale, same as BirdClaw.
  try {
    const mtime = statSync(path).mtime;
    return mtime.getTime() <= new Date(node.last_seen).getTime();
  } catch {
    return false; // Gone or unreadable — definitely not fresh.
  }
}

/** A cached result for this exact tool call, if one exists and the underlying file hasn't changed since. */
export async function getCached(toolName: string, args: Record<string, unknown>): Promise<string | undefined> {
  if (!CACHEABLE_TOOLS.has(toolName)) return undefined;
  const node = await getNode(nodeName(toolName, argsHash(toolName, args)));
  if (!node || !node.summary) return undefined;
  return isFresh(node, args) ? node.summary : undefined;
}

/** Remembers a tool call's result, keyed by tool name + a hash of its exact arguments. */
export async function store(toolName: string, args: Record<string, unknown>, result: string): Promise<void> {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  const hash = argsHash(toolName, args);
  // confidence 1.0: a cache entry isn't a corroborated belief that gets more
  // certain with repetition, it's a plain fact ("this call returned this")
  // that a fresh write should always replace outright, not blend with.
  // category carries the target path, so invalidatePath can find it again —
  // isFresh()'s own mtime check would eventually catch a stale entry lazily,
  // this just clears it out immediately instead of leaving it to linger.
  await upsertNode(nodeName(toolName, hash), "tool_cache", result, 1.0, {
    category: targetPath(args),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

/** Called after a write/edit succeeds, so a stale read of the same path doesn't serve pre-write content next time. */
export async function invalidatePath(path: string): Promise<void> {
  await deleteNodesByCategory("tool_cache", path);
}
