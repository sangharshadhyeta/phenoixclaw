import { spawn } from "node:child_process";
import path from "node:path";
import { PiRpcClient } from "../pi/rpc-client.js";
import { SdkPiClient } from "../pi/sdk-client.js";
import type { PiClient } from "../pi/types.js";

export type ExecutorKind = "host" | "container";

export interface LaunchOptions {
  sessionId: string;
  /** Absolute path of the workspace pi should work in (as seen by this process). */
  workspacePath: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** A previous run's pi session file, reopened so the conversation continues. */
  sessionFile?: string;
  /** Give this session the routine tools. Channel sessions only. */
  routineTools?: boolean;
  /** The routine being run, when this is a routine session. Enables reporting. */
  routineSlug?: string | null;
  /** Lowest role the conversation serves; decides which context files load. */
  role?: string;
  /** What kind of session this is — decides which tools are worth their schema. */
  kind?: "task" | "agent" | "routine";
  /** Whoever is speaking, read at each tool call. */
  whoNow?: () => { role: string; key?: string };
  /** False turns off the guard's taint rules for this session. */
  enforceTaint?: boolean;
  /**
   * True when this session's turns are the agent's own initiative rather than
   * anyone's request — held to the constitution's allowlist, and given
   * CONSTITUTION.md in full. See pi/constitution.ts.
   */
  autonomous?: boolean;
  /**
   * True when this conversation has already read something untrusted, from
   * `sessions.tainted`. The guard's own flag is per process; this is what
   * carries the taint across a restart.
   */
  tainted?: boolean;
  /**
   * Whether the workspace's own `.pi` resources may be loaded and executed.
   * Only true where the agent owns the tree — see session-manager.ts.
   */
  projectTrusted?: boolean;
}

export interface Executor {
  readonly kind: ExecutorKind;
  launch(opts: LaunchOptions): Promise<PiClient>;
  /** Best-effort cleanup of anything left behind outside the child process. */
  cleanup?(sessionId: string): Promise<void>;
}

function piArgs(opts: LaunchOptions, sessionDir: string): string[] {
  const args = ["--mode", "rpc", "--session-dir", sessionDir];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** Environment passed through to pi — provider credentials plus a sane PATH. */
function piEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // pi writes nothing interactive; make sure it never tries.
    CI: "1",
    TERM: "dumb",
  };
}

/**
 * Runs pi as a child process of the portal, working directly on mounted workspace
 * directories. Fast and simple; pi has the portal's own permissions, so this
 * assumes you trust the tasks you submit.
 */
export class HostExecutor implements Executor {
  readonly kind = "host" as const;

  constructor(private readonly sessionRoot: string) {}

  /** In-process via the SDK — see SdkPiClient for why this beats a subprocess. */
  launch(opts: LaunchOptions): Promise<PiClient> {
    return SdkPiClient.create({
      cwd: opts.workspacePath,
      sessionDir: path.join(this.sessionRoot, opts.sessionId),
      sessionFile: opts.sessionFile,
      routineTools: opts.routineTools,
      routineSlug: opts.routineSlug,
      role: opts.role,
      kind: opts.kind,
      sessionId: opts.sessionId,
      whoNow: opts.whoNow,
      enforceTaint: opts.enforceTaint,
      autonomous: opts.autonomous,
      tainted: opts.tainted,
      projectTrusted: opts.projectTrusted,
      provider: opts.provider,
      modelId: opts.model,
      thinkingLevel: opts.thinkingLevel,
    });
  }
}

/**
 * Runs pi inside a throwaway Docker container with only the workspace directory
 * mounted, so a task cannot reach the rest of the host.
 *
 * `docker run -i` keeps stdin open, which is what the JSONL protocol needs, and
 * the container is labelled so a crashed portal can still find and reap it.
 */
export class ContainerExecutor implements Executor {
  readonly kind = "container" as const;

  constructor(
    private readonly image: string,
    private readonly sessionRoot: string,
    private readonly limits: { memoryMb: number; cpus: number; pidsLimit: number }
  ) {}

  async launch(opts: LaunchOptions): Promise<PiClient> {
    const containerName = `pithagoras-${opts.sessionId}`;
    const sessionDir = path.join(this.sessionRoot, opts.sessionId);

    const passthrough = [
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "PI_PROVIDER",
      "PI_MODEL",
    ].flatMap((key) => (process.env[key] ? ["-e", `${key}=${process.env[key]}`] : []));

    const args = [
      "run",
      "-i",
      "--rm",
      "--name",
      containerName,
      "--label",
      "pithagoras.session=" + opts.sessionId,
      "--label",
      "pithagoras.managed=true",
      "-w",
      "/workspace",
      "-v",
      `${opts.workspacePath}:/workspace`,
      "-v",
      `${sessionDir}:/sessions`,
      // Same hardening posture as the sandboxes: no extra capabilities, no
      // privilege escalation, and hard resource ceilings.
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      `${this.limits.memoryMb}m`,
      "--memory-swap",
      `${this.limits.memoryMb}m`,
      "--cpus",
      String(this.limits.cpus),
      "--pids-limit",
      String(this.limits.pidsLimit),
      ...passthrough,
      this.image,
      "pi",
      ...piArgs({ ...opts }, "/sessions"),
    ];

    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    return new PiRpcClient(child);
  }

  async cleanup(sessionId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const rm = spawn("docker", ["rm", "-f", `pithagoras-${sessionId}`], { stdio: "ignore" });
      rm.on("exit", () => resolve());
      rm.on("error", () => resolve());
    });
  }
}

/**
 * Which session kinds may run under a given executor.
 *
 * `container` registers no guard at all — rpc-client.ts contains no reference
 * to guardExtension, roles, taint or the constitution, and ContainerExecutor
 * reads only `sessionId` and `workspacePath` from its LaunchOptions, silently
 * discarding `role`, `whoNow`, `enforceTaint`, `autonomous`, `tainted` and
 * `projectTrusted`.
 *
 * For a **task** session that is defensible, and is arguably the point: the
 * container *is* the boundary, only the workspace is mounted, capabilities are
 * dropped, and there is no speaker whose role could need checking.
 *
 * For an **agent** session it is not. A channel serves colleagues and
 * strangers, and the role check is what stops a colleague getting primary-level
 * access to the machine. Containerising the process protects the host; it does
 * nothing whatever about who is allowed to ask. The same holds for an
 * **autonomous routine**, where the constitution's allowlist is the only thing
 * bounding a turn nobody asked for.
 *
 * So those kinds are refused rather than run unguarded. Refusing is the
 * conservative reading of a genuine trade: falling back to `host` would keep
 * the feature working while quietly removing the isolation the operator
 * deliberately asked for, and running unguarded would keep it working while
 * quietly removing the guard. Neither is a decision to take on somebody's
 * behalf at runtime. The escape is one setting — EXECUTOR=host — and the boot
 * log names it.
 */
export function executorSupports(kind: ExecutorKind, session: "task" | "agent" | "routine"): boolean {
  return kind !== "container" || session === "task";
}

/** Why a kind is refused, in words an operator can act on. */
export function unsupportedReason(session: "task" | "agent" | "routine"): string {
  return session === "agent"
    ? "channel conversations need the people/roles check, which the container executor does not register — " +
        "a colleague or a stranger would get the same access as you. Set EXECUTOR=host to use channels."
    : "autonomous routines are bounded by the constitution's allowlist, which the container executor does " +
        "not register — a run nobody asked for would be unbounded. Set EXECUTOR=host to use them.";
}

export function buildExecutor(kind: ExecutorKind, sessionRoot: string): Executor {
  if (kind === "container") {
    return new ContainerExecutor(
      process.env.PI_IMAGE || "pithagoras-runner:latest",
      sessionRoot,
      {
        memoryMb: Number(process.env.TASK_MEMORY_MB) || 2048,
        cpus: Number(process.env.TASK_CPUS) || 2,
        pidsLimit: Number(process.env.TASK_PIDS_LIMIT) || 512,
      }
    );
  }
  return new HostExecutor(sessionRoot);
}
