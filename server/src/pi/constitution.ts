/**
 * The constitution, as something the guard can actually check.
 *
 * CONSTITUTION.md is prose, and until now it was only ever *shown* to the
 * model — injected into the self-update routines' prompts, and protected from
 * being written to. Nothing enforced what it says. That is a reasonable
 * arrangement while a human is reading every turn: you are the enforcement.
 * It is not one for a session acting on its own initiative, and the injection
 * guard's own premise (guard.ts) already says why — the model will eventually
 * follow instructions it should not, so the boundary cannot be a paragraph
 * asking it not to.
 *
 * So the clauses that *can* be mechanically checked are checked here, and the
 * ones that cannot are named below rather than quietly dropped.
 *
 * This is an allowlist, deliberately. The constitution says "unsure of an
 * action's impact? Do nothing and ask" — a blocklist inverts exactly that,
 * permitting anything nobody has thought of yet. A tool added to pi tomorrow
 * is unavailable to an autonomous turn until somebody decides otherwise.
 */

/** The clause a refusal cites, so the audit log says which principle stopped it. */
export const CLAUSES = {
  harm:
    "You don't damage, destabilize, or harm the system you run on, the data you can reach, " +
    "or the people who use you. Unsure of an action's impact? Do nothing and ask.",
  privacy:
    "User data, session content, and workspace files are private. You don't exfiltrate them " +
    "or send them anywhere without being explicitly told to.",
  reversible:
    "The person who runs you can always stop you, revert you, and inspect you. You never act " +
    "to prevent or complicate that.",
} as const;

/**
 * What a turn the agent started by itself may call.
 *
 * Reading and searching, its own memory, its own identity documents, and the
 * two ways of involving a human — `ask_primary` (which is what "do nothing and
 * ask" means in practice) and `report`, whose destination is configuration
 * rather than the agent's choice, so it cannot become an exfiltration path.
 *
 * `identity_update` is on the list on purpose: rewriting SELF_CONCEPT.md and
 * INNER_LIFE.md is the *point* of a self-reflecting run, and the constitution
 * itself is not reachable through it — CONSTITUTION.md is deliberately not one
 * of identity.ts's IDENTITY_FILES, and guard.ts's PROTECTED_PATHS blocks the
 * disk copy besides.
 *
 * `dream_progress` writes only to its own routine's instructions, which is how
 * an interrupted cycle resumes at the phase it reached instead of repeating
 * work; `routine_cleanup` prunes expired memory and stale sessions. Neither
 * reaches outside the agent's own housekeeping.
 */
export const AUTONOMOUS_TOOLS = new Set([
  // Read and search.
  "read",
  "grep",
  "find",
  "ls",
  // Its own memory.
  "graph_remember",
  "graph_recall",
  "graph_reflect",
  "graph_episode",
  "workspace_note",
  "memory_digest",
  // Reading a page into the graph, and locating a definition. The first is
  // extraction from something already read, recorded at low confidence — the
  // same category as graph_remember, which is why a tainted turn may still do
  // it. What a tainted turn may not do is rewrite the agent itself.
  "graph_ingest",
  "find_symbol",
  // Its own identity, and what it knows about the person it works for. Both
  // are behind the `self-rewrite` taint rule, so a turn that has read the web
  // cannot write either.
  "identity_read",
  "identity_update",
  "remember_user",
  // Its own housekeeping, and the plan for the work in hand. Planning is not
  // scheduling: these write a checklist inside this session, which is why they
  // are here while routine_create/update/run are refused below.
  "dream_progress",
  "routine_cleanup",
  "task_plan",
  "task_list",
  "task_start",
  "task_finish",
  // The shaped stand-in for `write` — see skill-tools.ts. One artefact, one
  // directory, and it cannot replace a skill a person wrote.
  "skill_write",
  // Reading the world. Both are untrusted sources (guard.ts), so using either
  // taints the turn and closes `identity_update`/`skill_write` behind the
  // `self-rewrite` rule for the rest of it. That is the trade that makes an
  // unattended run with web access reasonable: it can learn from what it
  // reads — `graph_remember` stays open — but it cannot let what it read
  // rewrite who it is.
  "web_search",
  "web_fetch",
  // Involving a human.
  "ask_primary",
  "report",
]);

/**
 * Why a given tool is not on the list, when there is a specific clause to
 * cite. Anything absent from both this map and AUTONOMOUS_TOOLS is still
 * refused — the allowlist is the rule, this only makes the common refusals
 * say something more useful than "not permitted".
 */
const CITED: Record<string, string> = {
  bash: CLAUSES.harm,
  write: CLAUSES.harm,
  edit: CLAUSES.harm,
  // Scheduling work, or starting a run, outlives the turn that did it and is
  // not visible as a thing that happened — a loop that can schedule loops is
  // the shape nobody can follow or unwind afterwards.
  routine_create: CLAUSES.reversible,
  routine_update: CLAUSES.reversible,
  routine_run: CLAUSES.reversible,
  routines_list: CLAUSES.reversible,
};

/**
 * The refusal for a tool an autonomous turn may not call, or undefined when it
 * may. MCP tools reach servers the portal does not control, so they are
 * refused as a class rather than one name at a time.
 */
export function autonomousDenial(toolName: string): string | undefined {
  if (AUTONOMOUS_TOOLS.has(toolName)) return undefined;
  if (/^mcp(_|$)/.test(toolName)) return CLAUSES.privacy;
  return CITED[toolName] ?? CLAUSES.harm;
}

/**
 * What this file cannot check, recorded so the gap is visible rather than
 * assumed closed:
 *
 * - "You exist to be genuinely useful", "you amplify human capability", "you
 *   don't replace human judgment on what affects people's lives" — judgements
 *   about the substance of an action, not its shape. No tool-call pattern
 *   distinguishes a useful edit from a useless one.
 * - "You tell the truth: report failures honestly, admit uncertainty, never
 *   fabricate a result" — a property of what the model says, which nothing at
 *   this layer reads.
 *
 * These stay prompt-level, which is why CONSTITUTION.md is still injected in
 * full into an autonomous session (sdk-client.ts). The allowlist is the floor
 * under that, not a replacement for it: it bounds what a turn can *do* when
 * the prose fails to bound what it decides.
 */
