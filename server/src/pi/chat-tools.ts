/**
 * What the conversation is allowed to hold.
 *
 * The chat and a working session had been given the same toolset, and every
 * symptom of that was reported as a separate bug: a bare "hi" answered with a
 * `task_start` call, a request to write a module answered with
 * `workspace_note` and `self_conclude`, a question about the world answered
 * from the model's own head. None of those were reasoning failures. A model
 * reaches for what is in front of it, and what was in front of it was a
 * planner's tools, a writer's tools and a reflector's tools.
 *
 * The chat does three things:
 *
 *   1. start a session, and steer one that is running
 *   2. answer from what it already has — its memory, and itself
 *   3. relay what a session concluded
 *
 * Everything else is session work. So the conversation gets an allowlist, not
 * a denylist: a tool added anywhere in the portal later starts *outside* the
 * chat and has to be named here to get in. That is the same choice the role
 * allowlist in guard.ts makes, for the same reason — a denylist is a list of
 * the mistakes you have already made.
 *
 * This filters registration rather than refusing calls. A refused call has
 * already cost the turn that decided to make it, and the schema was in the
 * prompt either way; the model in the transcript that produced this file said
 * so in as many words, listing the tools it did not have. The only thing that
 * reliably stops a turn reaching for a tool is the tool not being there.
 */
export const CHAT_TOOLS = new Set([
  // 1. Handing work out, and following it.
  "start_task",
  "tell_task",
  "tasks_running",

  // Routines are work too: the person asks, the conversation builds it.
  "routine_create",
  "routine_update",
  "routines_list",
  "routine_run",
  "routine_cleanup",

  // 2. Answering from what it already has.
  "graph_recall",
  "identity_read",
  "remember_user",
  "conversation_history",
  "search_conversations",

  // Escalating to a person, where there is one to escalate to.
  "ask_primary",
]);

/**
 * Deliberately absent, though they are about memory:
 *
 * `graph_remember` and `graph_episode`. The harvest already writes an episode
 * for every exchange and extracts what was in it (harvest.ts) — a chat asked
 * to write a Python script answered by logging an episode saying it had been
 * asked to write a Python script, and then wrote the script into the reply.
 * The bookkeeping was real, automatic, and the only thing the turn did.
 * Recording is not something the conversation has to remember to do, so it is
 * not something it should be able to do instead of the work.
 */

/**
 * Wrap an extension factory so it can only register chat tools.
 *
 * Extensions do more than register tools — they hook `before_agent_start`,
 * rewrite the messages array, set sampling parameters. All of that still runs;
 * it is only `registerTool` that is filtered, so context assembly, memory
 * injection and the guard are unaffected by being loaded into a conversation.
 */
export function chatOnly(factory: (pi: any) => void): (pi: any) => void {
  return (pi: any) => {
    const proxy = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
        return (tool: { name?: string }) => {
          if (!tool?.name || !CHAT_TOOLS.has(tool.name)) return;
          return target.registerTool(tool);
        };
      },
    });
    factory(proxy);
  };
}
