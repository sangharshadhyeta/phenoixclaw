import { getNode, upsertNode } from "./graph.js";

/**
 * Fetched web pages, kept for a while. Ports BirdClaw's `memory/page_store.py`.
 *
 * BirdClaw keeps these as one JSON file per URL, separate from the graph: the
 * graph is the navigation layer and the page store the reference layer behind
 * it. Here they are `page` nodes in the same graph, because the split it exists
 * to make — "entities over here, the content they point at over there" — is
 * what a node's `summary` already is. A second store would be a second thing to
 * prune, back up and keep consistent, for a distinction the schema is already
 * expressing.
 *
 * That `page` node type has been declared since the graph landed, and until now
 * nothing wrote one — it was schema for a feature that did not exist yet, and
 * `routine_cleanup` was dutifully pruning a type that was always empty. This is
 * the missing half.
 *
 * Two things it buys, beyond tidiness. A loop that reads the web every few
 * minutes stops re-fetching the same page it read an hour ago. And what it read
 * becomes searchable afterwards — `graph_recall` finds page content the same
 * way it finds anything else, so "what did that page say" survives the session
 * that fetched it.
 */

/**
 * A day, matching the tool cache.
 *
 * These are a cache of something that changes, not an archive of something
 * that does not: a page re-read tomorrow may legitimately differ, and serving
 * yesterday's copy as though it were current is the failure mode worth
 * avoiding. `routine_cleanup` prunes what expires.
 */
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** The node name for a URL. Prefixed so a page can never collide with a fact someone named after a link. */
const pageKey = (url: string) => `page:${url}`;

/** The cleaned text of this URL if it was fetched recently, else undefined. */
export async function recallPage(url: string): Promise<string | undefined> {
  const node = await getNode(pageKey(url));
  if (!node?.summary) return undefined;
  // A node past its expiry is stale but may not have been pruned yet — cleanup
  // runs on a routine, not on every read, so freshness is checked here too.
  if (node.expires_at && new Date(node.expires_at).getTime() < Date.now()) return undefined;
  return node.summary;
}

/**
 * Remember what a URL contained.
 *
 * confidence 1.0 for the same reason the tool cache uses it: this is not a
 * belief that grows more certain by being re-observed, it is a record of what
 * a fetch returned, and a fresh fetch should replace it outright rather than
 * blend with it. `category` carries the URL so the entry is findable by it.
 */
export async function rememberPage(url: string, cleaned: string): Promise<void> {
  if (!cleaned.trim()) return;
  await upsertNode(pageKey(url), "page", cleaned, 1.0, {
    category: url,
    expiresAt: new Date(Date.now() + PAGE_TTL_MS),
  });
}
