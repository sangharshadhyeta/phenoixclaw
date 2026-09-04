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
import { cachedTools } from "./cached-tools.js";
import { workspaceContext } from "./workspace-context.js";
import { readAgentFile } from "../agent-setup.js";
import { readIdentity, type IdentityFile } from "../identity.js";
import { agentHome } from "../agent.js";

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
const CONTEXT_FILES: IdentityFile[] = ["SOUL.md", "PrimaryUser.md", "MEMORY.md", "SELF_CONCEPT.md", "INNER_LIFE.md"];
const SHARED_FILES: IdentityFile[] = ["SOUL.md", "SELF_CONCEPT.md", "INNER_LIFE.md"];

const filesFor = (role?: string) => (!role || role === "primary" ? CONTEXT_FILES : SHARED_FILES);

/**
 * Handed to pi's agentsFilesOverride as {path, content} pairs — pi never
 * re-reads the path, it's a label only, so a synthetic agentHome()-relative
 * path here is fine even though the content actually came from the graph.
 */
async function extraContextFiles(role?: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const name of filesFor(role)) {
    const content = await readIdentity(name);
    if (content) out.push({ path: path.join("identity", name), content });
  }
  return out;
}

/**
 * A short anchor saying the files are the agent's own.
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
  if (!present.length) return "";

  const lines = [`${present.join(", ")} are yours, not reference material about someone else. Each opens with a block saying what it is for; follow it.`];

  // Deep identity injection for core files
  const soul = contents[names.indexOf("SOUL.md")];
  if (soul) lines.push(`\n# YOUR IDENTITY\n${soul}`);
  const selfConcept = contents[names.indexOf("SELF_CONCEPT.md")];
  if (selfConcept) lines.push(`\n# YOUR SELF-CONCEPT\n${selfConcept}`);

  return lines.join("\n");
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
    /**
     * The routine this session runs, when it is one. Gives the agent the report
     * tool, so a run with nobody watching can still reach someone.
     */
    routineSlug?: string | null;
    /** Whoever is speaking right now — read at each tool call. */
    whoNow?: () => { role: string; key?: string };
    /** Lowest role this conversation serves, deciding which context files load. */
    role?: string;
    /** The portal's session id, for tools that record against it. */
    sessionId?: string;
    /** False lets a run act on what it read — see guardExtension. */
    enforceTaint?: boolean;
    /** True when nobody asked for this turn — see pi/constitution.ts. */
    autonomous?: boolean;
  }): Promise<SdkPiClient> {
    // Imported lazily so the server still boots (and the container executor
    // still works) if the SDK cannot initialise in this environment.
    const pi: any = await import("@earendil-works/pi-coding-agent");

    const modelRuntime = await pi.ModelRuntime.create();

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
            opts.sessionDir,
            opts.whoNow ?? (() => ({ role: "primary" })),
            opts.sessionId,
            opts.enforceTaint !== false,
            opts.cwd,
          ) },
        // Every session, unconditionally: remembering/recalling durable facts
        // is a normal-conversation thing, not limited to a routine or role.
        { name: "graph", factory: graphTools(opts.cwd) },
        // Every session too: MEMORY.md/SELF_CONCEPT.md/INNER_LIFE.md are
        // graph-backed now (identity.ts) — this is how any session, not just
        // the self-reflection routine, writes to them.
        { name: "identity", factory: identityTools() },
        // Overrides read/ls with graph-backed memoization of their results.
        // Registered after the tool-bearing factories above and before any
        // below for no reason but legibility — an override is resolved by
        // name at refresh time, not by registration order.
        { name: "cached-tools", factory: cachedTools(opts.cwd) },
      ];
      // A file listing of the agent's own home is noise: agent and routine
      // sessions live there and are not working on it. A task session is
      // pointed at a repository, which is exactly what the snapshot is for.
      if (path.resolve(opts.cwd) !== path.resolve(agentHome())) {
        factories.push({ name: "workspace-context", factory: workspaceContext(opts.cwd) });
      }
      if (opts.routineTools)
        factories.push({ name: "routines", factory: routineTools(opts.sessionId) });
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
      // explicitly rather than picked up by extraContextFiles/framing's
      // directory-presence check, because neither runs with agentHome() as
      // its cwd — a self-update routine's cwd is the source tree being
      // patched (SERVER_ROOT / PI_SOURCE_DIR).
      //
      // An autonomous run gets it because guard.ts's allowlist only bounds
      // what such a turn can *do*: the clauses about being useful, telling
      // the truth and not substituting for human judgement are about what it
      // decides, and nothing below the prompt can check those. The allowlist
      // is the floor under the prose, not a replacement for it — see the
      // closing comment in pi/constitution.ts.
      const isSelfUpdate =
        opts.routineSlug === "self-update-phoenixclaw" || opts.routineSlug === "self-update-pi";
      const constitution =
        isSelfUpdate || opts.autonomous ? readAgentFile("CONSTITUTION.md") : "";
      // Resolved up front, not inside agentsFilesOverride/appendSystemPrompt
      // below: both are plain synchronous values/callbacks the SDK reads
      // without awaiting, but the content itself now lives in the graph
      // (identity.ts), which is only reachable asynchronously.
      const contextFiles = await extraContextFiles(opts.role);
      const framingText = await framing(opts.role);
      resourceLoader = new pi.DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: pi.getAgentDir(),
        // Available everywhere without being installed, and not editable in
        // place: they belong to the image, so an edit would be lost on the next
        // deploy without saying so.
        ...(builtinSkills ? { additionalSkillPaths: [builtinSkills] } : {}),
        // Inline rather than an installed package: the portal owns routines, so
        // a package would have to call back over HTTP to reach the database it
        // sits beside. Absent unless asked, so a task session never sees them.
        // Registered only where each belongs: routine management for sessions
        // reached through a channel, reporting for routine runs.
        ...(factories.length ? { extensionFactories: factories } : {}),
        // pi discovers one context file per directory — AGENTS.md or CLAUDE.md
        // — so the agent's own files would be invisible to it. Rather than
        // generating an AGENTS.md from them and keeping it in sync, they are
        // handed to pi as context files directly. Nothing to regenerate, and an
        // edit is live for the next session that starts.
        agentsFilesOverride: (base: { agentsFiles: any[] }) => ({
          agentsFiles: [...base.agentsFiles, ...contextFiles],
        }),
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

    const { session } = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager,
      modelRuntime,
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

  async prompt(message: string): Promise<void> {
    // expandPromptTemplates lets "/name" resolve to its template or extension
    // command, which is how the TUI treats the same input.
    await this.session.prompt(message, { expandPromptTemplates: true });
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
