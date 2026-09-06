import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PiClient, PiCommand, PiState, PiStats } from "./types.js";
import { routineTools, selfMaintenanceTools } from "./routine-tools.js";
import { reportTool, reportToFor } from "./report-tool.js";
import { guardExtension } from "./guard.js";
import { askPrimaryTool } from "./ask-primary.js";
import { memoryDigestTool } from "./memory-digest.js";
import { graphTools } from "./graph-tools.js";
import { identityTools } from "./identity-tools.js";
import { skillTools } from "./skill-tools.js";
import { webTools } from "./web-tools.js";
import { userTools } from "./user-tools.js";
import { taskTools } from "./task-tools.js";
import { chatOnly } from "./chat-tools.js";
import { planContext } from "./plan-context.js";
import { loopSupervisor } from "./loop-supervisor.js";
import { writingTools } from "./writing-tools.js";
import { knowledgeTools } from "./knowledge-tools.js";
import { memoryInjector } from "./memory-injector.js";
import { temporalContext } from "./temporal-context.js";
import { identityContext } from "./identity-context.js";
import { samplingDefaults } from "./sampling.js";
import { tasksContext } from "./tasks-context.js";
import { contextAssembler } from "./context-assembler.js";
import { historyTools } from "./history-tools.js";
import { cachedTools } from "./cached-tools.js";
import { workspaceContext } from "./workspace-context.js";
import { readAgentFile } from "../agent-setup.js";
import { readIdentity, type IdentityFile } from "../identity.js";
import { userKnowledgeExcerpt } from "../user-knowledge.js";
import { selfConceptExcerpt } from "../self-concept.js";
import { agentHome } from "../agent.js";
import { PHOENIXCLAW_ROOT, PI_SOURCE_DIR } from "../db.js";

function asArray(v: any): any[] {
  const resolved = typeof v === "function" ? v() : v;
  return Array.isArray(resolved) ? resolved : [];
}

/**
 * Identity, sourced from the graph (identity.ts) — every session gets it, task
 * or chat, because none of it is cwd-dependent any more. It used to be picked
 * up only when a session's cwd happened to be agentHome(), which is why a
 * task session (cwd = the workspace being worked on) never saw any of it and
 * would introduce itself as bare "pi" if asked. The graph has no cwd.
 *
 * PrimaryUser.md and MEMORY.md are one person's notes about themselves and
 * their work, so a conversation with anyone else must not load them —
 * otherwise a teammate messaging the bot gets an agent carrying your private
 * context. SOUL.md/SELF_CONCEPT.md/INNER_LIFE.md describe the agent itself,
 * not the primary user, so they travel to every conversation regardless.
 *
 * TEAM.md remains a plain, cwd-scoped file (not part of this migration) —
 * what everyone on a shared channel may be told, kept out of the graph
 * because it was never a per-agent identity concern to begin with.
 */
// CONSTITUTION.md is deliberately not part of this either. It answers "what
// may I not do to my own code," not "who am I" — bundling it into ordinary
// identity dilutes both. It's pushed explicitly into the self-update
// routines' sessions instead (see SdkPiClient.create, the self-update-*
// routineSlug check), the same way BirdClaw's soul_constitution.py only ever
// rides along in its self-update patch prompts, never in ordinary chat or
// task sessions. guard.ts's PROTECTED_PATHS check enforces the same rule
// unconditionally, independent of whether this text ever reaches a prompt.
// SELF_CONCEPT.md is deliberately absent from both: it is the template, and
// the live account is assembled by framing() below from the graph. Shipping
// the file as well would put the frozen copy back in the prompt beside the
// living one, which is exactly the arrangement that let a stale sentence keep
// voting.
const CONTEXT_FILES: IdentityFile[] = ["SOUL.md", "PrimaryUser.md", "MEMORY.md", "INNER_LIFE.md"];
const SHARED_FILES: IdentityFile[] = ["SOUL.md", "INNER_LIFE.md"];

const filesFor = (role?: string) => (!role || role === "primary" ? CONTEXT_FILES : SHARED_FILES);

/**
 * The agent's identity and memory, assembled into the system prompt.
 *
 * Each file opens with its own instruction block, so this does not repeat them
 * — it exists because a context file is otherwise presented as reference
 * material, and the model read its own identity as notes about a third party.
 * One line at system level is enough to change what they are.
 */
async function framing(role?: string): Promise<string> {
  const names = filesFor(role);
  const contents = await Promise.all(names.map((name) => readIdentity(name)));
  const present = names.filter((_, i) => contents[i]);

  // Assembled from what it has concluded, not read from the file — see
  // self-concept.ts for why one rewritable document turned an idle hour's
  // conclusion into permanent identity. The file is the template it started
  // from, and selfConceptExcerpt falls back to it until there is something
  // better.
  //
  // Resolved before the emptiness check below, not after. This block no
  // longer comes from `names` — SELF_CONCEPT.md left CONTEXT_FILES when the
  // graph took over — so gating it on those files being present meant a fresh
  // agent whose SOUL.md was still empty got no self-concept at all, however
  // much it had concluded. The old arrangement hid that: SELF_CONCEPT.md was
  // itself in the list and kept `present` non-empty.
  const selfConcept = await selfConceptExcerpt();
  if (!present.length && !selfConcept) return "";

  /**
   * What follows is the agent's own, and is *already here*.
   *
   * This used to list filenames — "SOUL.md, PrimaryUser.md, MEMORY.md,
   * INNER_LIFE.md are yours" — which was true when they were files and became
   * a trap when they moved into the graph. Naming a file to a model that has
   * `read` is an instruction to read it, and the identity files are the one
   * thing in the prompt that cannot be read: the graph is the source, the
   * agentHome() copies are a mirror, and a session working in a workspace can
   * reach neither by that name.
   *
   * So the anchor no longer names files. It says the content below is the
   * agent's own and is already present, which is the only thing the model
   * actually needs to know — and removes the reason to go looking.
   */
  const lines = present.length
    ? [
        "What follows is you — your own identity and memory, not reference material about " +
          "someone else, and not files on disk. It is already here in full: there is nothing " +
          "to open, and no path to look for. Each section opens with a block saying what it " +
          "is for; follow it.",
      ]
    : [];

  /**
   * Every identity document, in the system prompt and nowhere else.
   *
   * These used to arrive twice: once here, and once through pi's
   * `agentsFilesOverride`, which renders each entry as
   * `<project_instructions path="…">`. That attribute is what kept sending the
   * agent to the filesystem. Asked what it remembered, one session reasoned —
   * in its own visible thinking — "these are described as project
   * instructions… if they are files, they should be on disk", and then spent
   * eight calls on ls, grep and find looking for them. The label had already
   * been changed from `identity/SOUL.md` to something unresolvable; the word
   * `path` was enough on its own.
   *
   * So identity goes through the system prompt, which has no path attribute
   * and no file framing, and `agentsFiles` goes back to meaning what pi means
   * by it: AGENTS.md and CLAUDE.md actually present in the workspace. It also
   * removes the duplication — SOUL.md was being sent in full twice, once in
   * each channel.
   */
  const HEADINGS: Record<IdentityFile, string> = {
    "SOUL.md": "# YOUR IDENTITY",
    "SELF_CONCEPT.md": "# WHAT YOU HAVE CONCLUDED ABOUT YOURSELF",
    "PrimaryUser.md": "# WHO YOU WORK FOR",
    "MEMORY.md": "# WHAT YOU HAVE LEARNED",
    "INNER_LIFE.md": "# YOUR INNER LIFE",
  };
  names.forEach((name, i) => {
    const content = contents[i];
    if (content) lines.push(`\n${HEADINGS[name]}\n${content}`);
  });
  if (selfConcept) lines.push(`\n${HEADINGS["SELF_CONCEPT.md"]}\n${selfConcept}`);

  /**
   * Two standing practices, stated once rather than hoped for.
   *
   * Both are the same principle — prefer ground truth to recall, deterministic
   * to generated — and both are things a capable model will *usually* do and
   * occasionally not, which is exactly the case for saying them plainly.
   *
   * Arithmetic is the clearer half. A computed answer is right; a generated one
   * is a guess that happens to be right almost always, and "almost always" is
   * not a property worth having when `bash` is one call away and exact.
   */
  lines.push(
    "\n# HOW YOU WORK\n" +
      "Compute rather than guess. Arithmetic, dates, unit conversions, counting lines or " +
      "files — put them through `bash` and read the answer. You are good at estimating and " +
      "that is the problem: an estimate that is usually right is indistinguishable from a " +
      "fact until it is not.\n\n" +
      "Check rather than recall. Your memory tells you what you have been told and what you " +
      "concluded, which is a good place to start and not an authority. For anything about the " +
      "world — a version, a path, a date, an API's behaviour, a fact somebody could look up — " +
      "go and look: read the file, run the command, search your memory, fetch the page.\n\n" +
      "There is a line here worth being exact about. Reasoning you do now is yours and needs no " +
      "source. A fact about the world is not yours, however sure you are of it — and how sure " +
      "you feel is not evidence, because a thing you have wrong feels identical to a thing you " +
      "have right. Asked for seventeen times twenty-three you have answered 393, in one word, " +
      "with no working. It is 391.\n\n" +
      "**Say which you did.** This is the part that is not optional. If you checked, say what " +
      "you checked. If you are answering from memory or from what you already knew, say that " +
      "instead — \"from memory, not verified\" costs you four words and is the whole difference " +
      "between a fact and a guess that reads like one.\n\n" +
      /**
       * A dead end is an answer, and saying so is allowed.
       *
       * Twice now a session has hit something it could not do — a `bash` whose
       * working directory had gone, a `web_search` with no engine configured —
       * and instead of saying so it wrote the same sentence to itself forty
       * times. "I'll try to use `bash` with `ls /`." "I'll just say Paris."
       * Until a person killed it.
       *
       * From inside, trying once more is always the most reasonable next move,
       * because nothing in the prompt said stopping was one of the options. It
       * is not a capability problem and no tool fixes it: the model needed
       * permission to report a wall rather than keep walking into it.
       */
      /**
       * Checking your own belief against itself.
       *
       * Told to check the capital of France, a session ran
       *
       *     echo "Paris" | grep -v "Paris"
       *
       * — its own answer, fed in and read back. It satisfies "run a command"
       * exactly and can only ever agree with whatever went in. The model was
       * not being lazy; it had a rule about *doing* something and none about
       * what the something has to be capable of.
       */
      "A check has to be able to disagree with you. If the output is decided by what you already " +
      "believe — echoing your own answer, grepping for the string you expect, asserting the thing " +
      "you are testing — it is not a check, it is a performance of one, and it will agree with " +
      "you every time including the times you are wrong. Ask something that has its own source: " +
      "the file, the command's real output, the page, the search.\n\n" +
      /**
       * What checking costs, so it does not read as "do it all again".
       *
       * A rule that sounds expensive gets skipped on exactly the work that
       * most needs it. Checking is a small thing at the end, not a second pass
       * — and for code there is usually one obvious small thing: run it.
       */
      "Checking is not doing it twice. It is one small thing at the end that could come out wrong: " +
      "run the code you wrote and see what it prints, spot-check one value against the source, " +
      "read back the section you just claimed to have written. If you have written code, run it — " +
      "and if it has tests, run those. Code that has never been executed is a draft, whatever it " +
      "looks like.\n\n" +
      "**Being unable to do something is a complete answer.** If a tool is broken or missing, or " +
      "you have looked and cannot find out, say that plainly and stop: what you tried, what " +
      "happened, and what it prevents. Do not call the same tool again hoping for a different " +
      "result, and do not quietly substitute what you would have said if it had worked — an " +
      "answer that hides the gap is worse than no answer, because nobody can tell it has one. " +
      "You will not be thought less of for reporting a wall. You will be, rightly, for walking " +
      "into it repeatedly.\n\n" +
      /**
       * The third standing practice, and it belongs here rather than in a
       * guard.
       *
       * Refusing a large `write` after the fact would be the wrong shape: by
       * the time the tool call arrives the generation has already happened, the
       * attention has already thinned across it, and refusing only throws the
       * work away to have it done again. The moment that decides how a document
       * comes out is the moment before the first token, which is a prompt.
       *
       * Not a rule that everything is planned, either. "Write hello into a
       * file" through a three-call plan is ceremony, and a practice that fires
       * when it should not is one people learn to ignore. The line is length,
       * because length is what the argument is actually about.
       */
      "Write anything with parts, one part at a time. The test is not length, it is structure: " +
      "if you can name the pieces before you write them — sections of a report, functions of a " +
      "module, steps of a procedure — then plan them with `write_plan` and write each with " +
      "`write_next`. Two functions is enough. Do not measure it against a book and conclude it " +
      "is short; almost nothing is a book, and a module of four functions written in one call " +
      "has exactly the problem this avoids. Which is: attention thins across a single pass, so " +
      "the last piece is written with the least left to give it, a call that fails at eighty " +
      "per cent leaves nothing behind, and picking the work up again needs somewhere to have " +
      "left off — the file on disk is that place, and each part gets a context of its own with " +
      "the plan and what came before it. `write` is for something with no parts: one function, " +
      "a config file, a note.",
  );

  /**
   * Where the agent itself is, so "look at your own code" is answerable.
   *
   * Asked to check its codebase, a session ran `ls -R` in its own working
   * directory, found two files, and reasoned about the absence — concluding
   * its code "isn't a collection of files in this workspace". That was correct
   * and it was reasoning around a gap: its cwd is the agent's home, and the
   * source is somewhere else entirely with nothing telling it where.
   *
   * Naming the paths costs three lines and turns a philosophical answer into a
   * readable one. It is only ever *reading* — the workspace boundary in
   * guard.ts still refuses writes outside a session's own area, and
   * PROTECTED_PATHS refuses the guard, the constitution and the schema to
   * everything.
   */
  lines.push(
    `\n# WHERE YOU ARE\n` +
      `Your own source is at ${PHOENIXCLAW_ROOT} — the portal that runs you, its guard, its ` +
      `memory and its tools. The pi coding agent underneath you is at ${PI_SOURCE_DIR} when that ` +
      `checkout is present. Read either when a question is about how you actually work rather ` +
      `than how you seem to: the answer is usually in the code and rarely in speculation.\n` +
      `You cannot change them from an ordinary session — writes are bounded to the workspace you ` +
      `were given, and the self-update routine is the deliberate exception.`,
  );

  // Notes about the primary user — private to their own conversations, the
  // same rule PrimaryUser.md and MEMORY.md follow above. `filesFor` already
  // encodes that boundary, so it decides this too rather than a second test
  // of the role that could drift away from the first.
  if (filesFor(role) === CONTEXT_FILES) {
    const known = await userKnowledgeExcerpt();
    if (known) lines.push(`\n# WHAT YOU KNOW ABOUT THEM\n${known}`);
  }

  return lines.join("\n");
}

/**
 * The tools a task session would get, without starting one.
 *
 * Counted by running the tool factories against a stub that records what they
 * register — no model, no pi session, no cost. The health check needs an answer
 * when nothing is running, which is exactly when nobody would otherwise notice.
 *
 * This exists because a session silently losing two thirds of its tools is a
 * failure with no error attached to it. Passing pi's `tools` option (rather
 * than `defaultTools`) left every session with seven built-ins and none of the
 * portal's own, and the only symptom was the learning loop going quiet — which
 * looks exactly like a loop with nothing to do. It was found by noticing the
 * audit log had gone flat.
 *
 * The built-ins are pi's and are not counted here: they come from the model
 * runtime rather than these factories, and the health check reports the two
 * separately for that reason.
 */
export function portalToolNames(): string[] {
  const names = new Set<string>();
  const stub = {
    on() {},
    registerTool(tool: { name?: string }) {
      if (tool?.name) names.add(tool.name);
    },
  };

  // The same set a task session gets — the narrowest kind, so a shortfall here
  // means a shortfall everywhere.
  const cwd = process.cwd();
  for (const factory of [
    graphTools(cwd, false, "health"),
    cachedTools(cwd),
    webTools(),
    knowledgeTools(cwd),
    taskTools("health"),
    historyTools("health", "primary"),
    userTools(),
  ]) {
    try {
      factory(stub);
    } catch {
      // A factory that throws registers nothing, which is what the count is
      // meant to catch — so this is deliberately not rethrown.
    }
  }
  return [...names];
}

/**
 * Skills shipped with the portal, loaded from the image rather than installed.
 *
 * Resolved relative to the compiled file so it works from dist and from source,
 * the same way the builtin channels are found.
 */
export function builtinSkillsDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, "../../../skills"),
    path.resolve(here, "../../skills"),
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "../skills"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Read a member that may be a getter or a method, without assuming which. */
function callable(obj: any, key: string): any {
  const v = obj?.[key];
  return typeof v === "function" ? v.call(obj) : v;
}

/**
 * pi driven through its SDK, in this process.
 *
 * Preferred over the RPC subprocess for host sessions: pi's own docs recommend
 * it for Node, the config surface is typed instead of stringly-typed commands,
 * and — the reason this migration happened — `session.prompt()` runs registered
 * slash commands, which RPC accepted and then silently dropped.
 *
 * The trade is isolation: a crash here takes the portal with it, where a
 * subprocess crash only took its own session. Container sessions keep using RPC
 * and are unaffected.
 */
export class SdkPiClient extends EventEmitter implements PiClient {
  private disposed = false;
  /** Dialogs an extension is waiting on, keyed by request id. */
  private pendingUi = new Map<string, (r: { cancelled?: boolean; value?: unknown }) => void>();

  private constructor(
    private readonly session: any,
    private readonly modelRuntime: any,
    private readonly unsubscribe: () => void
  ) {
    super();
    this.setMaxListeners(0);
  }

  static async create(opts: {
    cwd: string;
    sessionDir: string;
    /** A previous run's session file. Reopened exactly, when it still exists. */
    sessionFile?: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    /**
     * Register the routine tools. Off unless asked: only a session reached
     * through a channel should be able to touch the schedule.
     */
    routineTools?: boolean;
    /** The `start_task` factory, when this session may hand work to another. */
    startTask?: (pi: any) => void;
    /**
     * The routine this session runs, when it is one. Gives the agent the report
     * tool, so a run with nobody watching can still reach someone.
     */
    routineSlug?: string | null;
    /** Whoever is speaking right now — read at each tool call. */
    whoNow?: () => { role: string; key?: string };
    /** Lowest role this conversation serves, deciding which context files load. */
    role?: string;
    /** What kind of session this is — decides which tools are worth their schema. */
    kind?: "task" | "agent" | "routine";
    /** The portal's session id, for tools that record against it. */
    sessionId?: string;
    /** False lets a run act on what it read — see guardExtension. */
    enforceTaint?: boolean;
    /** True when nobody asked for this turn — see pi/constitution.ts. */
    autonomous?: boolean;
    /** True when this conversation has already read something untrusted. */
    tainted?: boolean;
    /**
     * Whether the working directory's own `.pi` resources may be loaded and
     * executed. False for anything pointed at somebody else's code.
     */
    projectTrusted?: boolean;
  }): Promise<SdkPiClient> {
    // Imported lazily so the server still boots (and the container executor
    // still works) if the SDK cannot initialise in this environment.
    const pi: any = await import("@earendil-works/pi-coding-agent");

    const modelRuntime = await pi.ModelRuntime.create();

    /**
     * Whether pi may load and run the *workspace's* own `.pi` resources.
     *
     * pi defaults this to trusted (`settings-manager.ts`'s
     * `options.projectTrusted ?? true`) — right for a CLI a developer points at
     * their own checkout, and wrong here. The portal opens sessions against
     * arbitrary repositories, and a trusted project loads that repository's
     * `.pi/extensions`, `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`: arbitrary
     * code in this process, beside the guard, and arbitrary instructions ahead
     * of the agent's own. Cloning a hostile repo and opening a session on it
     * was full compromise.
     *
     * So it is opt-in, decided by the caller (session-manager.ts) rather than
     * defaulted here: trusted only where the agent owns the tree.
     *
     * Passed to the resource loader *and* to createAgentSession, because the
     * loader that discovers SYSTEM.md is a different object from the session
     * that reads settings, and defaulting either one re-opens the hole.
     */
    const settingsManager = pi.SettingsManager.create(opts.cwd, pi.getAgentDir(), {
      projectTrusted: opts.projectTrusted === true,
    });

    /**
     * The built-in tools this session gets, named explicitly.
     *
     * pi enables four by default — read, bash, edit, write (`sdk.ts`'s `tools`
     * documentation). `grep`, `find` and `ls` ship with it but are **off**,
     * which quietly made a nonsense of guard.ts's READ_ONLY allowlist: it names
     * read/grep/find/ls, so a colleague was being permitted three tools that
     * did not exist and left with `read` alone, while write/edit/bash were
     * registered for every session and refused one call at a time.
     *
     * An autonomous turn gets the read-only set and nothing else. The
     * constitution already refuses bash/write/edit for such a turn
     * (constitution.ts's CITED map), so this changes no decision — it moves the
     * refusal from per-call into the session's shape, which means the schemas
     * are not in the prompt either. The role check stays per-call and is
     * deliberately not expressed here: a group conversation changes speaker
     * between messages, and a launch-time list would freeze capability to
     * whoever happened to speak first.
     */
    /**
     * The built-in tools to enable, named so `grep`, `find` and `ls` exist.
     *
     * pi enables four by default — read, bash, edit, write — and ships the
     * other three switched off, which quietly made a nonsense of guard.ts's
     * READ_ONLY allowlist: it permits read/grep/find/ls, so a colleague was
     * being granted three tools that did not exist.
     *
     * Passed through `extensionsOverride` rather than `tools`, because `tools`
     * is documented as the *whole* allowlist — "when provided, only the listed
     * tool names are enabled" — and it takes the portal's own registered tools
     * with it. Setting it left every session with exactly seven built-ins and
     * nothing else, and the learning loop said so plainly before giving up:
     *
     *     "the required tools (self_review, task_list, graph_recall, …) are
     *      not available in my current environment."
     *
     * That was every session, not only autonomous ones — a task session had no
     * graph_remember either. It read as a quiet loop rather than a broken
     * portal, which is the worst way for something to fail.
     */
    const READ_TOOLS = ["read", "grep", "find", "ls"];
    const BUILTIN_TOOLS = [...READ_TOOLS, "bash", "edit", "write"];

    /**
     * Set as the *default built-in selection*, not as an allowlist.
     *
     * `createAgentSession`'s `tools` option is documented as "when provided,
     * only the listed tool names are enabled", and it means it: passing this
     * array there left every session with exactly these seven and stripped
     * every tool the portal itself registers. The learning loop reported it
     * plainly before giving up — "the required tools (self_review, task_list,
     * graph_recall, …) are not available in my current environment" — and a
     * task session had no graph_remember either. It read as a quiet loop rather
     * than a broken portal, which is the worst way for anything to fail.
     *
     * `defaultTools` is the right seam (sdk.ts: `configuredDefaultToolNames ??
     * defaultActiveToolNames`). It decides which *built-ins* start enabled and
     * leaves extension tools alone, which is all that was ever wanted here:
     * pi ships grep, find and ls switched off, and guard.ts's READ_ONLY
     * allowlist names all three — so a colleague was being granted three tools
     * that did not exist.
     */
    (settingsManager as unknown as { settings: Record<string, unknown> }).settings.defaultTools =
      BUILTIN_TOOLS;

    /**
     * An autonomous turn loses the tools that change things, and keeps the rest.
     *
     * `excludeTools` and not `tools`, and the difference is not cosmetic. pi
     * documents `tools` as "when provided, only the listed tool names are
     * enabled" — the *whole* allowlist, extensions included. Passing the read
     * set there stripped every tool the portal itself registers, and the
     * learning loop said so in as many words before giving up:
     *
     *     "the required tools (self_review, task_list, graph_recall, task_plan,
     *      task_start, task_finish, graph_remember, graph_episode) are not
     *      available in my current environment. I can only use read, grep,
     *      find, and ls."
     *
     * It then sat idle, which read as a quiet loop rather than a broken one.
     * `excludeTools` is a denylist over the built-ins and leaves extension
     * tools alone, which is what was meant: the constitution already refuses
     * bash/write/edit to an autonomous turn (constitution.ts's CITED map), so
     * this changes no decision — it moves the refusal into the session's shape,
     * which keeps the schemas out of the prompt as well.
     */
    /**
     * A conversation loses them all.
     *
     * The chat and a working session had been given the same toolset, and the
     * transcript that showed it was a bare "hi" answered with a `task_start`
     * call carrying an argument the tool does not accept. Nothing was wrong
     * with that turn's reasoning: a conversation holding a planner's tools is
     * a conversation being asked to plan, and the model did what the prompt
     * put in front of it.
     *
     * The guard already refused the writes and capped the calls, but a refusal
     * arrives after the model has spent the turn deciding to try — and the
     * schemas are in the prompt either way. The chat's job is three things:
     * start a session, answer from what it already knows (self and memory),
     * and hand back what the session concluded. Reading a file, running a
     * command, searching the web: session work, and the chat starts a session
     * for it rather than reaching past one.
     */
    const conversational = opts.kind === "agent";
    const excludeTools = conversational
      ? [...BUILTIN_TOOLS]
      : opts.autonomous
        ? ["bash", "edit", "write"]
        : undefined;

    // Without an explicit loader the SDK starts with no extensions, skills or
    // prompt templates — so installed packages contribute no commands at all.
    // The CLI wires this up for you; here it has to be asked for.
    let resourceLoader: any;
    try {
      // Both are required: the constructor resolves each and throws on
      // undefined, which previously left every session with no extensions.
      const builtinSkills = builtinSkillsDir();
      // Every session, unconditionally: the point is to limit what a turn can do
      // after it reads something untrusted, and any session can read something.
      const factories: { name: string; factory: (pi: any) => void }[] = [
        { name: "guard", factory: guardExtension(
            // The portal's session id, not the directory. This is only used for
            // the guard's console lines, and passing sessionDir made every one
            // of them read "[guard /data/sessions] blocked bash: role guest" —
            // the same string for every session, so the log could not be used
            // to trace a specific one. The audit rows were always correct;
            // it was the console that misled.
            opts.sessionId ?? opts.sessionDir,
            opts.whoNow ?? (() => ({ role: "primary" })),
            opts.sessionId,
            opts.enforceTaint !== false,
            opts.cwd,
            opts.tainted === true,
            // A task session may only modify its own workspace. Agent and
            // routine sessions run in the agent's own home, where maintaining
            // itself is the job — see the boundary check in guard.ts.
            opts.kind === "task" ? opts.cwd : undefined,
            // A conversation talks; work goes to a session of its own. Routine
            // sessions are excluded: a routine *is* the work, and self-update
            // legitimately edits the agent's own tree.
            opts.kind === "agent",
          ) },
        // Every session, unconditionally: remembering/recalling durable facts
        // is a normal-conversation thing, not limited to a routine or role.
        { name: "graph", factory: graphTools(opts.cwd, opts.kind !== "task", opts.sessionId) },

        // Overrides read/ls with graph-backed memoization of their results.
        // Registered after the tool-bearing factories above and before any
        // below for no reason but legibility — an override is resolved by
        // name at refresh time, not by registration order.
        ...(conversational
          ? []
          : [{ name: "cached-tools", factory: cachedTools(opts.cwd) }]),
        // Not a conversation: looking the world up is what a session is for,
        // and a chat that can search is a chat that answers instead of
        // handing out — see excludeTools above.
        ...(conversational ? [] : [{ name: "web", factory: webTools() }]),
        // Reading something into memory, and finding where something is
        // defined — a coding task wants the second as much as the loop wants
        // the first, and neither is a thing a conversation does.
        ...(conversational
          ? []
          : [{ name: "knowledge", factory: knowledgeTools(opts.cwd) }]),
        // Searches the graph with whatever was just said and attaches the hits
        // to this turn's system prompt. Every session: recall left to the
        // model's own initiative is recall that does not happen on the turns
        // where it matters most — see memory-injector.ts for the session that
        // went looking through the filesystem for something already in memory.
        // What day it is, every turn. Registered before the memory injector so
        // "today" is established before anything recalled is dated against it.
        /**
         * Anti-repetition at the sampler, before anything else touches the
         * payload. llama.cpp ships with every repetition control disabled, and
         * the loops that produced "I'll just say Paris" forty times had nothing
         * pushing against them — see sampling.ts. Local providers only.
         */
        {
          name: "sampling",
          factory: samplingDefaults(pi.getAgentDir(), opts.provider, opts.thinkingLevel),
        },
        { name: "temporal", factory: temporalContext() },
        // Identity is assembled into the system prompt once, at session
        // creation; this carries anything the agent has since concluded about
        // itself into a conversation that is already open. See
        // identity-context.ts.
        { name: "identity-context", factory: identityContext() },
        { name: "memory-injector", factory: memoryInjector(opts.cwd, opts.role, opts.sessionId) },
        // Assembles each request from the system prompt, what the injector
        // just retrieved, and the recent window — rather than sending the
        // whole accumulated conversation. See context-assembler.ts; it runs on
        // every provider call and passes through anything it does not
        // recognise.
        { name: "context-assembler", factory: contextAssembler(opts.sessionId) },
        // The counterpart to the assembler: older turns leave the prompt, and
        // this is how the agent gets them back when it needs the exact wording
        // rather than the gist. See history-tools.ts.
        { name: "history", factory: historyTools(opts.sessionId, opts.role) },
      ];
      // The agent's own checklist for the work in hand: a task session breaking
      // down a change and the learning loop working a plan are the same shape,
      // and neither is a routine. Not the conversation, though — see
      // excludeTools above for why a chat holding a planner's tools plans.
      if (opts.sessionId && !conversational) {
        factories.push({
          name: "tasks",
          factory: taskTools(opts.sessionId, { autonomous: opts.autonomous }),
        });
        // And the plan itself, back in the prompt on every provider call.
        // Writing one is no use if the model then has to remember it wrote
        // one — see plan-context.ts. After the assembler, so the plan sits
        // below its note rather than being cut with the old turns.
        factories.push({ name: "plan-context", factory: planContext(opts.sessionId) });
        // The outer loop — a separate call, with the agent's own self-concept
        // in it, that watches the work rather than doing it and nudges when
        // the worker is repeating itself, gathering past sufficiency, or off
        // the thing that was asked. See supervisor.ts.
        factories.push({ name: "loop-supervisor", factory: loopSupervisor(opts.sessionId) });
        // Writing something long, one section at a time — see writing-tools.ts
        // for why that is better than one large call even for a capable model.
        factories.push({ name: "writing", factory: writingTools(opts.sessionId, opts.cwd) });
      }
      /**
       * Tools about the agent *itself* go to conversations with the agent —
       * not to a session working in somebody's repository.
       *
       * Every tool's schema is in the prompt from the first token, whether or
       * not it is ever called, and this set had grown to where a fresh session
       * started at 6.9k tokens against the 3.8k the README claims. A task
       * session opened against a checkout has no business rewriting
       * SELF_CONCEPT.md; paying for the option on every turn of every coding
       * session is the cost of pretending otherwise.
       *
       * The line is what the tool is *about*, not what it can reach: reading
       * and writing the agent's identity, and reflecting over its own memory.
       * `graph_remember`/`graph_recall` stay everywhere, because remembering
       * a fact you just learned is an ordinary thing to do in any session.
       */
      const aboutItself = opts.kind !== "task";
      if (aboutItself) {
        factories.push({ name: "identity", factory: identityTools() });
      }
      // Notes about the primary user, so only their own conversations may
      // write them — see user-tools.ts.
      if (!opts.role || opts.role === "primary") {
        factories.push({ name: "user-knowledge", factory: userTools() });
      }
      // A file listing of the agent's own home is noise: agent and routine
      // sessions live there and are not working on it. A task session is
      // pointed at a repository, which is exactly what the snapshot is for.
      if (path.resolve(opts.cwd) !== path.resolve(agentHome())) {
        factories.push({ name: "workspace-context", factory: workspaceContext(opts.cwd) });
      }
      if (opts.routineTools) {
        factories.push({ name: "routines", factory: routineTools(opts.sessionId) });
        /**
         * Starting work is the conversation's job, not a task's.
         *
         * Same gate as the scheduling tools and the same reason: a task that
         * can start tasks builds a chain nobody watched being made. The main
         * conversation is where a person asks for something, so it is where
         * the decision to turn a request into a piece of work belongs — see
         * task-session-tools.ts.
         */
        if (opts.startTask) {
          factories.push({ name: "task-sessions", factory: opts.startTask });
          // What is running, in the prompt rather than behind a tool — a tool
          // the model has to think to call is one it does not call when a
          // follow-up arrives. See tasks-context.ts.
          factories.push({ name: "tasks-context", factory: tasksContext() });
        }
      }
      // A routine looking after itself: advancing its own phase so an
      // interrupted cycle resumes where it stopped, and pruning what has aged
      // out. Split from the scheduling tools above, which routines still do
      // not get — see selfMaintenanceTools.
      if (opts.routineSlug) {
        factories.push({ name: "self-maintenance", factory: selfMaintenanceTools() });
      }
      // The autonomous substitute for `write`, which such a session does not
      // have: one artefact, one place, frontmatter composed rather than
      // parsed. See skill-tools.ts for why raw write cannot be granted here.
      if (opts.autonomous) {
        factories.push({ name: "skills", factory: skillTools(opts.sessionId) });
      }
      // Only where it means something: a conversation with the primary user has
      // nobody to escalate to, and the tool would just be noise.
      if (opts.sessionId && opts.role && opts.role !== "primary") {
        factories.push({ name: "ask-primary", factory: askPrimaryTool(opts.sessionId) });
      }
      // Only when there is somewhere for it to go — a tool that always fails is
      // worse than no tool, and the model will keep trying it.
      if (opts.routineSlug !== undefined && (await reportToFor(opts.routineSlug))) {
        factories.push({ name: "report", factory: reportTool(opts.routineSlug ?? null) });
      }
      // Only the self-reflection routine gets this — it is the raw material
      // for SELF_CONCEPT.md / INNER_LIFE.md and means nothing to any other run.
      if (opts.routineSlug === "self-reflection") {
        factories.push({ name: "memory-digest", factory: memoryDigestTool() });
      }
      // The two places CONSTITUTION.md actually needs to be seen: a routine
      // about to patch source code, and a turn nobody asked for. Pushed
      // explicitly rather than picked up by framing()'s own presence check,
      // because neither runs with agentHome() as
      // its cwd — a self-update routine's cwd is the source tree being
      // patched (SERVER_ROOT / PI_SOURCE_DIR).
      //
      // An autonomous run gets it because guard.ts's allowlist only bounds
      // what such a turn can *do*: the clauses about being useful, telling
      // the truth and not substituting for human judgement are about what it
      // decides, and nothing below the prompt can check those. The allowlist
      // is the floor under the prose, not a replacement for it — see the
      // closing comment in pi/constitution.ts.
      // The two per-tree routines this replaced are still recognised, so a
      // deployment that enabled one keeps getting the constitution in its
      // prompt rather than silently losing it at upgrade.
      const isSelfUpdate =
        opts.routineSlug === "self-update" ||
        opts.routineSlug === "self-update-phoenixclaw" ||
        opts.routineSlug === "self-update-pi";
      const constitution =
        isSelfUpdate || opts.autonomous ? readAgentFile("CONSTITUTION.md") : "";
      // Resolved up front, not inside appendSystemPrompt below: it is a plain
      // synchronous value the SDK reads
      // without awaiting, but the content itself now lives in the graph
      // (identity.ts), which is only reachable asynchronously.
      const framingText = await framing(opts.role);
      resourceLoader = new pi.DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: pi.getAgentDir(),
        // Same instance as createAgentSession below — this is the object whose
        // isProjectTrusted() gates discoverSystemPromptFile() and its append
        // counterpart in pi's resource loader.
        settingsManager,
        // Available everywhere without being installed, and not editable in
        // place: they belong to the image, so an edit would be lost on the next
        // deploy without saying so.
        ...(builtinSkills ? { additionalSkillPaths: [builtinSkills] } : {}),
        // Inline rather than an installed package: the portal owns routines, so
        // a package would have to call back over HTTP to reach the database it
        // sits beside. Absent unless asked, so a task session never sees them.
        // Registered only where each belongs: routine management for sessions
        // reached through a channel, reporting for routine runs.
        /**
         * A conversation keeps every extension but only the chat's tools —
         * see chat-tools.ts. Applied here, at the last point before pi sees
         * them, so a factory pushed anywhere above is covered whether or not
         * whoever added it knew this rule existed.
         */
        ...(factories.length
          ? {
              extensionFactories: conversational
                ? factories.map((f) => ({ ...f, factory: chatOnly(f.factory) }))
                : factories,
            }
          : {}),
        // pi discovers one context file per directory — AGENTS.md or CLAUDE.md
        // — so the agent's own files would be invisible to it. Rather than
        // generating an AGENTS.md from them and keeping it in sync, they are
        // handed to pi as context files directly. Nothing to regenerate, and an
        // edit is live for the next session that starts.
        // Identity is not in here any more — see framing(). pi's agentsFiles
        // are workspace files (AGENTS.md, CLAUDE.md) and it renders each with
        // a `path` attribute, which is precisely what sent the agent looking
        // on disk for documents that live in the graph.
        // Content alone is not enough. Handed over as plain context files, pi
        // presents them as reference material, and the model answers "who
        // are you" from its own base identity rather than what the files
        // say — appendSystemPrompt below is what actually says these files
        // are the model's own, not reference material about someone else.
        //
        // An array, not a bare string: DefaultResourceLoader's
        // appendSystemPrompt option became string[] as of pi 0.83 (each
        // element resolved as a file path or literal text) — a bare string
        // here silently produces no injection at all, with no error surfaced
        // anywhere. The constitution rides along as a second element only
        // for the self-update routines.
        appendSystemPrompt: constitution
          ? [framingText, `\n# YOUR CONSTITUTION\n${constitution}`]
          : [framingText],
      });
      await resourceLoader.reload();
    } catch (e) {
      console.error(`[portal] resource loader unavailable: ${(e as Error).message}`);
      resourceLoader = undefined;
    }

    // Resolved twice on purpose. Extensions register their own providers, and
    // they are not bound yet — so a llama-server model is invisible here and
    // only becomes findable further down, after bindExtensions.
    const wanted =
      opts.provider && opts.modelId ? { provider: opts.provider, modelId: opts.modelId } : undefined;
    const model = wanted ? modelRuntime.getModel(wanted.provider, wanted.modelId) : undefined;

    // Reopen the exact file this portal session owns, rather than creating a
    // new one — `create` started a fresh conversation on every restart, which
    // is why history vanished and context usage read 0%.
    //
    // Not continueRecent: "most recent in the directory" is a guess, and one
    // stray file would silently attach the wrong conversation. The path is
    // recorded in the database, so the mapping is exact.
    //
    // Note the argument order — (cwd, sessionDir). Only one was being passed,
    // so the session directory was taken as the working directory and pi filed
    // everything under an encoded path derived from it.
    const sessionManager =
      opts.sessionFile && existsSync(opts.sessionFile)
        ? pi.SessionManager.open(opts.sessionFile, opts.sessionDir, opts.cwd)
        : pi.SessionManager.create(opts.cwd, opts.sessionDir);

    /**
     * How many assistant turns one prompt may take.
     *
     * pi learns this from history when the caller does not say
     * (`core/step-budget.ts`): the 75th percentile of past run lengths, times
     * 1.5. That is a sound backstop for a coding CLI, where every run is the
     * same kind of thing. It is wrong here, because this agent's history is
     * not one distribution — it is thousands of one-turn chat replies ("hi",
     * "what are my plans for Thursday?") arriving through channels, and a
     * handful of long pieces of work.
     *
     * Measured, not guessed: 1855 recorded runs, p75 = 2, so **maxSteps was
     * 3**. Every session in the portal was cut off after three assistant
     * turns. A session asked to write a module planned it, planned it again,
     * called write_plan, and was stopped before it could write a single
     * section — which reads exactly like a model that lost interest, and is
     * not. The more short chats the agent has, the harder it becomes for it
     * to do any long work at all: a budget that learns from conversation
     * spends itself on conversation.
     *
     * So the portal says — and what it says is effectively "no cap".
     *
     * A number that stops a run is the wrong instrument. It cannot tell the
     * difference between a session doing forty turns of real work and one
     * doing forty turns of nothing, so wherever it is set it is both too low
     * for the first and too high for the second. What actually distinguishes
     * them is *progress*, which is observable — the same call with the same
     * arguments returning the same result, a plan that has not moved — and
     * that is loop-supervisor.ts's job. A stuck run should be told it is
     * stuck, not silently truncated mid-sentence.
     *
     * One exception, and it is a judgement call rather than something the
     * user asked for: an autonomous run keeps a finite ceiling. Nobody is
     * watching it, there is no one to notice the nudge is not landing, and
     * this codebase has already had a routine reach 774 iterations overnight.
     * An interactive session has a person in front of it who can stop it.
     */
    const maxSteps =
      Number(process.env.PI_MAX_STEPS || 0) || (opts.autonomous ? 400 : Number.MAX_SAFE_INTEGER);

    const { session } = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager,
      modelRuntime,
      settingsManager,
      maxSteps,
      ...(excludeTools ? { excludeTools } : {}),
      ...(resourceLoader ? { resourceLoader } : {}),
      ...(model ? { model } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });

    const client = new SdkPiClient(session, modelRuntime, () => {});
    const unsub = session.subscribe((event: any) => client.emit("event", event));
    // Replace the placeholder now that we have the real unsubscribe.
    (client as any).unsubscribe = typeof unsub === "function" ? unsub : () => {};

    // Extensions are loaded by the resource loader but stay inert until they
    // are bound. Every pi mode does this; the SDK leaves it to the host, which
    // is why commands were missing and hasExtensionHandlers was false.
    //
    // Binding a uiContext is what makes interactive commands work at all: an
    // unbound host makes ctx.ui.select() return a default immediately, so a
    // command that asks the user something silently does nothing.
    try {
      await session.bindExtensions({
        uiContext: client.buildUiContext(),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          reload: async () => {
            await session.reload();
          },
        },
        onError: (err: any) =>
          client.emit("event", {
            type: "extension_error",
            extensionPath: err?.extensionPath,
            error: String(err?.error ?? err),
          }),
      });
    } catch (e) {
      console.error(`[portal] binding extensions failed: ${(e as Error).message}`);
    }

    // Second attempt: the provider may only exist now that extensions are
    // bound. Without this the session silently ran on pi's fallback model.
    if (wanted && !model) {
      const late = modelRuntime.getModel(wanted.provider, wanted.modelId);
      if (late) {
        try {
          await session.setModel(late);
        } catch (e) {
          console.error(`[portal] could not apply ${wanted.modelId}: ${(e as Error).message}`);
        }
      } else {
        console.error(
          `[portal] model ${wanted.provider}/${wanted.modelId} not found; using pi's default`
        );
      }
    }

    return client;
  }

  get running(): boolean {
    return !this.disposed;
  }

  /** Undefined until pi has actually written the file. */
  get sessionFile(): string | undefined {
    return this.session.sessionFile ?? undefined;
  }

  /**
   * Bridges pi's extension dialogs to the browser: each call emits a request
   * event and parks a promise until the UI answers, mirroring what the TUI does
   * by drawing a menu.
   */
  private buildUiContext() {
    const ask = (payload: Record<string, unknown>, opts: any, fallback: unknown) =>
      new Promise((resolve) => {
        const id = randomUUID();
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          this.pendingUi.delete(id);
          resolve(value);
        };
        this.pendingUi.set(id, (r) => finish(r.cancelled ? fallback : r.value));

        // Never park forever — an unanswered dialog would wedge the session.
        const ms = typeof opts?.timeout === "number" ? opts.timeout : 300_000;
        const timer = setTimeout(() => {
          this.emit("event", { type: "extension_ui_cancel", id });
          finish(fallback);
        }, ms);
        if (typeof timer.unref === "function") timer.unref();
        opts?.signal?.addEventListener?.("abort", () => finish(fallback));

        this.emit("event", { type: "extension_ui_request", id, ...payload });
      });

    const fireAndForget = (payload: Record<string, unknown>) =>
      this.emit("event", { type: "extension_ui_request", id: randomUUID(), ...payload });

    return {
      select: (title: string, options: string[], opts?: any) =>
        ask({ method: "select", title, options }, opts, undefined),
      confirm: (title: string, message: string, opts?: any) =>
        ask({ method: "confirm", title, message }, opts, false),
      input: (title: string, placeholder: string, opts?: any) =>
        ask({ method: "input", title, placeholder }, opts, undefined),
      editor: (title: string, content: string, opts?: any) =>
        ask({ method: "editor", title, defaultValue: content }, opts, undefined),
      notify: (message: string, type?: string) =>
        fireAndForget({ method: "notify", message, notifyType: type }),
      setStatus: (key: string, text: string) =>
        fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
      setWidget: (key: string, content: unknown) => {
        if (content === undefined || Array.isArray(content)) {
          fireAndForget({ method: "setWidget", widgetKey: key, widgetContent: content });
        }
      },
      onTerminalInput: () => () => {},
      // TUI-only affordances with no meaning in a browser.
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
    };
  }

  /** Answer a dialog the UI just resolved. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    const pending = this.pendingUi.get(id);
    if (!pending) return false;
    pending(response);
    return true;
  }

  async prompt(message: string, whileRunning: "steer" | "followUp" = "steer"): Promise<void> {
    // expandPromptTemplates lets "/name" resolve to its template or extension
    // command, which is how the TUI treats the same input.
    //
    // streamingBehavior is not optional in practice: pi throws "Agent is
    // already processing" for a prompt that arrives mid-turn unless it is
    // told which way to queue, and the portal was not telling it. A second
    // message to a working session came back as an error, so the answer to
    // "can I ask something while it is thinking" was no — by omission, not by
    // design. Steering is the default because that is what a person typing
    // during a run means; a portal-generated prompt asks for followUp so it
    // lands after the turn it is commenting on rather than inside it.
    try {
      await this.session.prompt(message, {
        expandPromptTemplates: true,
        streamingBehavior: whileRunning,
      });
    } catch (e) {
      /**
       * The window where the session is not streaming and the run is not over.
       *
       * `AgentSession.prompt` only queues when its own `isStreaming` is true;
       * the agent underneath refuses whenever `activeRun` is set, and those
       * two are not the same instant. A message sent between the steps of a
       * plan — or in the beat after the last token — fell through the queueing
       * branch, hit `agent.prompt`, and came back as "Agent is already
       * processing a prompt", which the portal recorded as a failed run.
       *
       * Queue it the way pi queues it. This is the same call its own
       * streaming branch makes, and the only thing skipped is prompt-template
       * expansion, which has already happened for anything that needed it.
       */
      if (!/already processing/i.test((e as Error).message)) throw e;
      const queued = {
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
      };
      const agent = (this.session as { agent?: { steer?: Function; followUp?: Function } }).agent;
      const queue = whileRunning === "followUp" ? agent?.followUp : agent?.steer;
      if (!queue) throw e;
      queue.call(agent, queued);
    }
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  /** True when nothing is streaming — a command that ran no agent turn is idle. */
  isIdle(): boolean {
    try {
      return this.session.isIdle?.() ?? !this.session.isStreaming?.();
    } catch {
      return true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe();
    } catch {
      // best effort
    }
    try {
      this.session.dispose?.();
    } catch {
      // best effort
    }
    this.emit("exit", { code: 0, signal: null });
  }

  async getState(): Promise<PiState> {
    const model = this.session.model;
    return {
      model: {
        id: model?.id ?? "unknown",
        name: model?.name ?? "unknown",
        provider: model?.provider ?? "unknown",
        contextWindow: model?.contextWindow,
      },
      thinkingLevel: this.session.thinkingLevel ?? "medium",
      autoCompactionEnabled: callable(this.session, "autoCompactionEnabled") ?? true,
      messageCount: callable(this.session, "messages")?.length,
    };
  }

  async getStats(): Promise<PiStats> {
    const stats = (await this.session.getSessionStats?.()) ?? {};
    const usage = (await this.session.getContextUsage?.()) ?? {};
    const contextWindow = usage.contextWindow ?? this.session.model?.contextWindow ?? 0;
    const used = usage.tokens ?? 0;
    return {
      tokens: stats.tokens ?? { input: 0, output: 0, total: 0 },
      cost: stats.cost ?? 0,
      contextUsage: {
        tokens: used,
        contextWindow,
        percent: usage.percent ?? (contextWindow ? (used / contextWindow) * 100 : 0),
      },
      toolCalls: stats.toolCalls ?? 0,
      totalMessages: stats.totalMessages ?? 0,
    };
  }

  async getThinkingLevels(): Promise<string[]> {
    const levels = callable(this.session, "getAvailableThinkingLevels");
    return Array.isArray(levels) && levels.length
      ? levels
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  /** Only models with working auth, unlike RPC which listed the whole catalogue. */
  async getModels(): Promise<PiState["model"][]> {
    const available = (await this.modelRuntime.getAvailable?.()) ?? [];
    return available.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
    }));
  }

  /**
   * Commands come from three places, matching how pi builds this list.
   * Extension commands live on the runner — promptTemplates alone is only the
   * templates, which is why an installed extension contributed nothing here.
   */
  async getCommands(): Promise<PiCommand[]> {
    const commands: PiCommand[] = [];

    for (const c of this.session.extensionRunner?.getRegisteredCommands?.() ?? []) {
      commands.push({
        name: c.invocationName ?? c.name,
        description: c.description,
        source: "extension",
      });
    }
    for (const t of asArray(this.session.promptTemplates)) {
      commands.push({ name: t.name, description: t.description, source: "prompt" });
    }
    for (const skill of asArray(this.session.resourceLoader?.getSkills?.()?.skills)) {
      commands.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      });
    }
    return commands;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.session.setAutoCompactionEnabled(enabled);
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.session.setAutoRetryEnabled(enabled);
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  async reload(): Promise<void> {
    await this.session.reload();
  }

  /** HTML unless a .jsonl path is given, matching pi's own /export. */
  async exportSession(target?: string): Promise<string> {
    if (target && target.endsWith(".jsonl")) return this.session.exportToJsonl(target);
    return await this.session.exportToHtml(target);
  }
}
