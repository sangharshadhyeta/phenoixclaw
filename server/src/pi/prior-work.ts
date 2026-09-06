import { existsSync, readFileSync } from "node:fs";
import { personalRecall, upsertNode, type NodeRow } from "../graph.js";
import { boundaryTail } from "./writing-tools.js";

/**
 * What this agent has already built, so the next attempt improves on it.
 *
 * Each plan run starts from an empty file in a fresh workspace, and the thing
 * the last run produced sits on disk in another one, unreferenced. Asked the
 * same thing twice, the agent writes it twice — and the second time is not
 * better than the first, because the first is not in front of it. That is the
 * whole of the waste: not the tokens, but that nothing accumulates.
 *
 * BirdClaw's line was "the file is the memory". This is the missing half of
 * that: the graph remembers *which* file, and what it was for, so the memory
 * can be looked up by what was asked rather than by where it happened to be
 * written.
 *
 * ## Why it is a pointer, not a copy
 *
 * The node holds the path, the request it answered, and a short description —
 * not the artefact. A file changes after it is recorded, and a copy in the
 * graph would confidently hand back a version that no longer exists. The
 * prior work is read from disk when it is used, or reported as gone.
 *
 * ## Why it is offered rather than imposed
 *
 * "You wrote this before" is a starting point, not an instruction. The request
 * may have changed, the earlier attempt may have been poor, and a run that
 * inherits a bad answer and polishes it is worse than one that starts again.
 * So the brief says what exists and leaves the judgement where it belongs.
 */

export interface PriorWork {
  file: string;
  goal: string;
  /** What is in it now, or undefined if it is no longer on disk. */
  content?: string;
}

/** Node names are the address in this graph, so the shape has to be stable. */
const nameFor = (file: string) => `artefact:${file}`;

/**
 * Record that this session produced this file, for this request.
 *
 * Written when a plan finishes rather than as each section lands: a half-built
 * file offered to a later run as prior work is worse than none, because it
 * looks finished.
 */
export async function rememberArtefact(file: string, goal: string, summary: string): Promise<void> {
  try {
    await upsertNode(
      nameFor(file),
      "episode",
      // The request first: recall matches on what was asked, and what was asked
      // is what a later run will be asking again.
      `${goal.trim().slice(0, 400)}\n\nWritten to ${file}. ${summary.trim().slice(0, 400)}`,
      0.7,
      { source: "plan run" },
    );
  } catch {
    // Failing to record prior work must never fail the work itself.
  }
}

/**
 * Anything this agent has built before that answers something like this.
 *
 * `personalRecall` rather than the project-scoped search: prior attempts are
 * exactly the case where the useful memory is in *another* workspace, which is
 * what project scoping is designed to hide. Two sessions asked the same thing
 * are two workspaces by construction.
 */
export async function priorWork(
  goal: string,
  cwd: string,
  deps: { recall?: (q: string, cwd: string, n: number) => Promise<NodeRow[]> } = {},
): Promise<PriorWork | undefined> {
  if (!goal.trim()) return undefined;
  let hits: NodeRow[] = [];
  try {
    hits = await (deps.recall ?? personalRecall)(goal, cwd, 8);
  } catch {
    return undefined;
  }
  return priorWorkFrom(hits, cwd);
}

/**
 * The same, over rows somebody has already fetched.
 *
 * The memory injector runs `personalRecall` on every turn anyway, so asking
 * again would be a second embedding call for a set of hits already in hand.
 */
export function priorWorkFrom(hits: NodeRow[], cwd: string): PriorWork | undefined {
  for (const hit of hits) {
    if (!hit.name?.startsWith("artefact:")) continue;
    const file = hit.name.slice("artefact:".length);
    // Not the file this run is writing — that is not prior work, it is the
    // work in hand, and offering it back would have a run "improve on" its own
    // half-finished output.
    if (file.startsWith(cwd)) continue;
    return {
      file,
      goal: String(hit.summary ?? "").split("\n")[0],
      content: existsSync(file) ? readFileSync(file, "utf8") : undefined,
    };
  }
  return undefined;
}

/** How prior work is put to a run that is about to plan. Empty when there is none. */
export function priorWorkBlock(prior: PriorWork | undefined): string {
  if (!prior) return "";
  if (!prior.content) {
    // Recorded, but gone. Saying so is still worth something — it tells the
    // run this has been attempted — and silently pretending otherwise would
    // have it look for a file that is not there.
    return [
      "",
      "# YOU HAVE DONE THIS BEFORE",
      "",
      `You wrote ${prior.file} for a similar request, but it is no longer on disk.`,
      "Nothing to build on, then — but you have been here before, so think about what you would",
      "do differently rather than repeating the first attempt from memory.",
    ].join("\n");
  }

  return [
    "",
    "# YOU HAVE DONE THIS BEFORE",
    "",
    `You wrote ${prior.file} for: ${prior.goal}`,
    "",
    "It ends like this:",
    "",
    boundaryTail(prior.content, 1200),
    "",
    "Read it in full before you plan. Improving what is there — filling the gaps, fixing what is",
    "wrong, taking the parts that hold up — is almost always better than writing it again from",
    "nothing, and it is the only way the second attempt is better than the first rather than",
    "merely different. If the request has changed, or that attempt was poor, say so and start",
    "fresh: this is something you have, not something you owe.",
  ].join("\n");
}
