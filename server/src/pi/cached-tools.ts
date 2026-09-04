import path from "node:path";
import { getCached, invalidatePath, store } from "../memory-cache.js";

/**
 * Persistent memoization for the read-only file tools, wired in by overriding
 * pi's own `read` and `ls`.
 *
 * An override rather than a hook because the hooks cannot do it: pi's
 * `tool_call` event can block a call or rewrite its arguments, and nothing
 * else — a handler that returns `{ block: true }` produces an *error* result
 * carrying its reason (agent-loop.ts's `createErrorToolResult`), so a cache
 * consulted there could never answer a call, only fail it. A tool registered
 * under a builtin's name does replace it: agent-session.ts's
 * `_refreshToolRegistry` seeds the registry with the builtins and then lets
 * custom tools overwrite by name. That is the only seam where a cached result
 * can actually be served instead of doing the work.
 *
 * Layered *above* pi's own cache rather than replacing it — the delegate
 * below is the real builtin definition, its in-process `withToolCache` memo
 * included, and this only wraps it. What that adds is persistence: pi's memo
 * is a plain Map in one process, so it starts empty after every portal
 * restart and is never shared between two sessions reading the same file.
 * The graph is neither.
 *
 * `read` and `ls` only — see memory-cache.ts's CACHEABLE_TOOLS for why grep
 * and find are excluded, and why pi excludes them too.
 */
const WRAPPED = ["read", "ls"] as const;

/**
 * The arguments to key this call by, with the path made absolute against the
 * session's cwd — the model passes relative paths, and memory-cache.ts stats
 * what it is given (see its `targetPath`). `ls` defaults to the cwd when the
 * path is omitted, matching the builtin's own default.
 */
function cacheArgs(cwd: string, params: any): Record<string, unknown> {
  const raw = typeof params?.path === "string" && params.path ? params.path : ".";
  return { ...(params ?? {}), path: path.resolve(cwd, raw) };
}

/**
 * Text-only results are stored; anything carrying an image is not.
 *
 * A read of a PNG comes back as base64 in the content, and the cache lives in
 * the knowledge graph — the same table holding the agent's identity and every
 * fact it knows. Parking megabytes of image data there to save a file read is
 * a bad trade, and `pruneByAge` would then be deleting a node whose real cost
 * was never its age.
 */
const isStorable = (result: any): boolean =>
  Array.isArray(result?.content) && result.content.every((part: any) => part?.type === "text");

/** An ExtensionFactory — see pi's InlineExtension. One instance per session. */
export function cachedTools(cwd: string) {
  return (pi: any): void => {
    const factories: Record<string, unknown> = {
      read: pi.createReadToolDefinition,
      ls: pi.createLsToolDefinition,
    };

    for (const name of WRAPPED) {
      const factory = factories[name];
      // A pi that stopped exporting one of these is not a reason to lose the
      // tool itself: leave the builtin in place rather than registering an
      // override that cannot delegate to anything.
      if (typeof factory !== "function") continue;
      const base = (factory as (cwd: string) => any)(cwd);

      pi.registerTool({
        ...base,
        async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
          const key = cacheArgs(cwd, params);
          const hit = await getCached(name, key);
          if (hit) {
            try {
              return JSON.parse(hit);
            } catch {
              // A row that will not parse is worth nothing and worth no
              // noise either: fall through and do the work, and the store
              // below overwrites it with something that will.
            }
          }
          const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
          if (isStorable(result)) await store(name, key, JSON.stringify(result));
          return result;
        },
      });
    }

    /**
     * Eager invalidation after a write, as BirdClaw does it.
     *
     * `isFresh`'s own mtime check would catch the stale entry anyway on the
     * next read — this just clears it immediately rather than leaving a row
     * that is already known to be wrong sitting in the graph until something
     * happens to ask for it.
     */
    pi.on("tool_result", (event: any) => {
      if (event.isError) return undefined;
      if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
      const raw = event.input?.path;
      if (typeof raw === "string" && raw) void invalidatePath(path.resolve(cwd, raw));
      return undefined;
    });
  };
}
