import type { PiClient, PiCommand } from "./types.js";

/**
 * pi's built-in slash commands are implemented by whichever mode is running,
 * so `session.getCommands()` returns only extensions, templates and skills —
 * the TUI draws its own. The portal has to supply them too.
 *
 * The names and descriptions are read from the SDK's own BUILTIN_SLASH_COMMANDS
 * so they track pi's releases, but that module is not on the package's exports
 * map, so it is resolved by file path rather than a bare specifier.
 *
 * `where` decides who handles a command — the server acts on the session, the
 * client opens a piece of UI. Commands not listed here are TUI concerns
 * (`/quit`, `/hotkeys`, `/trust`, the auth pair) and are left out rather than
 * offered as a menu of things that quietly do nothing.
 */
const PORTAL_SUPPORTED: Record<string, "server" | "client"> = {
  clear: "server",
  compact: "server",
  session: "server",
  export: "server",
  reload: "server",
  model: "client",
  settings: "client",
  new: "client",
  name: "client",
};

/** Used only if the SDK's internal module moves; keeps `/` working regardless. */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  clear: "Clear this conversation and start fresh",
  compact: "Manually compact the session context",
  session: "Show session info and stats",
  export: "Export session (HTML default, or specify path: .html/.jsonl)",
  reload: "Reload extensions, skills, prompts and settings",
  model: "Select model",
  settings: "Open settings",
  new: "Start a new session",
  name: "Set session display name",
};

export interface BuiltinCommand extends PiCommand {
  where: "server" | "client";
  argumentHint?: string;
}

let cached: BuiltinCommand[] | undefined;

/** pi's builtins, filtered to the ones the portal actually implements. */
export async function getBuiltinCommands(): Promise<BuiltinCommand[]> {
  if (cached) return cached;

  let sdkCommands: { name: string; description: string; argumentHint?: string }[] = [];
  try {
    // import.meta.resolve, not require.resolve: the package's exports map
    // declares only an "import" condition, so CJS resolution fails outright.
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mod: any = await import(new URL("core/slash-commands.js", entry).href);
    sdkCommands = mod.BUILTIN_SLASH_COMMANDS ?? [];
  } catch (e) {
    console.error(`[portal] builtin command list unavailable from SDK: ${(e as Error).message}`);
  }

  const bySdk = new Map(sdkCommands.map((c) => [c.name, c]));
  cached = Object.entries(PORTAL_SUPPORTED).map(([name, where]) => ({
    name,
    description: bySdk.get(name)?.description ?? FALLBACK_DESCRIPTIONS[name],
    argumentHint: bySdk.get(name)?.argumentHint,
    source: "builtin",
    where,
  }));
  return cached;
}

export async function findServerBuiltin(name: string): Promise<BuiltinCommand | undefined> {
  return (await getBuiltinCommands()).find((c) => c.name === name && c.where === "server");
}

/** Run a server-side builtin, returning the notice to show in the transcript. */
export async function runBuiltin(
  name: string,
  args: string,
  client: PiClient,
  session?: { clear: () => Promise<void> },
): Promise<string> {
  switch (name) {
    /**
     * Start again, for real.
     *
     * `/compact` shortens the conversation and keeps it; this ends it. Both
     * the pi conversation and the transcript go, so the chat is actually
     * empty rather than merely scrolled — which is what somebody typing
     * `/clear` is asking for.
     *
     * Nothing of value is lost by it. The harvest has already put what
     * mattered into the graph, so the agent still knows what it learned and
     * who it was talking to; what goes is the record of the exchange itself.
     */
    case "clear":
      if (!session) throw new Error("This session cannot be cleared.");
      await session.clear();
      return "Cleared. What was learned is in memory; the conversation starts fresh.";

    case "compact":
      await client.compact();
      return "Context compacted.";

    case "reload":
      await client.reload();
      return "Reloaded extensions, skills, prompts and settings.";

    case "session": {
      const [state, stats] = await Promise.all([client.getState(), client.getStats()]);
      return [
        `Model: ${state.model.name}`,
        `Effort: ${state.thinkingLevel}`,
        `Context: ${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} (${stats.contextUsage.percent.toFixed(1)}%)`,
        `Tokens: ${stats.tokens.input.toLocaleString()} in, ${stats.tokens.output.toLocaleString()} out`,
        `Cost: $${stats.cost.toFixed(4)}`,
        `Tool calls: ${stats.toolCalls}`,
      ].join("\n");
    }

    case "export": {
      const file = await client.exportSession(args.trim() || undefined);
      return `Exported to ${file}`;
    }

    default:
      throw new Error(`'${name}' is not a server-side command`);
  }
}
