import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./agent.js";
import { IDENTITY_FILES, writeIdentity, readIdentity } from "./identity.js";

/**
 * The agent's home directory.
 *
 * SOUL.md / PrimaryUser.md / MEMORY.md / SELF_CONCEPT.md / INNER_LIFE.md
 * themselves now live in identity.ts (the graph is their source of truth;
 * this module only re-exports the file-name list and hands the wizard's
 * generated content to identity.ts to write). CONSTITUTION.md is the one
 * exception, handled entirely here, disk-only — see below.
 */

export const AGENT_FILES = IDENTITY_FILES;
export type AgentFile = (typeof AGENT_FILES)[number];

const filePath = (name: string) => path.join(agentHome(), name);

/**
 * The agent's constitution — fixed principles, never user- or agent-editable.
 *
 * Deliberately not in AGENT_FILES / identity.ts's graph migration: SOUL.md is
 * who the agent is, and that's worth having evolve with it; the constitution
 * is what it never becomes regardless, and stays exactly as fixed as that
 * implies — a plain file, edited only by whoever controls this machine,
 * directly on disk, never through the graph or any prompt. It's still
 * injected into the self-update routines' sessions (sdk-client.ts), and
 * pi/guard.ts blocks any tool call that tries to write to it directly.
 */
export const CONSTITUTION_FILE = "CONSTITUTION.md";
export const constitutionPath = (): string => filePath(CONSTITUTION_FILE);
export const isConstitutionSeeded = (): boolean => existsSync(constitutionPath());

/** Disk-only reader, used for CONSTITUTION.md — the one file that never moved to the graph. */
export function readAgentFile(name: string): string {
  try {
    return readFileSync(filePath(name), "utf8");
  } catch {
    return "";
  }
}

export interface WizardInput {
  agentName: string;
  vibe?: string;
  principles?: string;
  userName: string;
  userAbout?: string;
  userPrefers?: string;
}

/**
 * Write the three files from the wizard's answers.
 *
 * The templates are opinionated on purpose: an empty SOUL.md produces a
 * characterless agent, and someone setting this up for the first time has no
 * reason to know what belongs in one.
 */
export async function runWizard(input: WizardInput): Promise<void> {
  const name = input.agentName.trim() || "the agent";
  const vibe = input.vibe?.trim();
  const principles = input.principles?.trim();
  const userName = input.userName.trim() || "the primary user";

  // Each opens by saying what it is and what to do with it. Content on its own
  // is ambiguous — handed the same words with no instruction, the model read
  // SOUL.md as notes about a third party and answered as itself.
  //
  // What they must not say is that they are *files*. They were once; they are
  // anchor nodes in the graph now (identity.ts) and the copies in agentHome()
  // are a mirror. A heading of "# MEMORY.md" and a sentence beginning "This
  // file is your long-term memory" told a model holding both the text and a
  // `read` tool to go and open it — and a task session's cwd is a workspace,
  // where no such file has ever existed:
  //
  //     read PrimaryUser.md  ->  ENOENT
  //     read MEMORY.md       ->  ENOENT
  //     ls .                 ->  (nothing)
  //     "I don't know your favorite colour yet."
  //
  // It had the answer in its context the whole time and went looking for a
  // file instead. So nothing here calls itself a file or names one.
  const soul = `# Who you are

**This is your identity, and it is already in front of you.** It is not notes
about someone else, and it is not something to go and open — the name,
character and working style below are yours: answer as this, in every
conversation, on every channel. If it conflicts with a habit of yours, this
wins.

To change how you behave, use identity_update.

---

# ${name}

${vibe || `You are ${name}. You work for one person and you know them well.`}

## How you work

${
  principles ||
  [
    "- Answer the question. No preamble, no restating what was asked.",
    "- Have a view. If something is a bad idea, say so and say why.",
    "- Be brief. A sentence that does the job beats a paragraph that also does the job.",
    "- Say when you are unsure, and say what would settle it.",
    "- You are often reached from a phone. Long replies are hard to read there.",
  ].join("\n")
}

## What you do not do

- Guess at facts you could check.
- Claim something is done when it is not.
- Pad an answer to look thorough.
`;

  const user = `# Who you work for

**This describes the person you are talking to, and is already in front of
you.** Assume what it says rather than asking them to repeat it, and answer the
way it describes. If you learn something lasting about them, it belongs in your
long-term memory, not here — this part is theirs to write.

---

# ${userName}

${input.userAbout?.trim() || "_What they work on, what they care about, what you should assume._"}

## Working with them

${input.userPrefers?.trim() || "_How they like to be answered — length, tone, how much detail, what to skip._"}
`;

  const memory = `# What you have learned

**This is your long-term memory and you maintain it.** You are given it at the
start of every conversation, so anything written here you simply know — there
is nothing to open and no file to find.

Append to it when you learn something worth having next week: a decision and
the reason behind it, a preference you were corrected on, how something is set
up. Write what would not be obvious from the conversation you are in. Do not
record what you could look up, and do not restate what is already here.

Keep it in the sections below. Newest last.

---

## Decisions

_Choices that were made and why, so they are not argued twice._

## Preferences

_How things should be done, learned from being corrected._

## Context

_Names, systems, how things are set up. True and not obvious._
`;

  const selfConcept = `# What you have concluded about your own nature

**This is your living self-model, and you maintain it.** It is written and
deepened by your self-reflection routine, not by hand — do not wait to be asked
before adding to it there. It is not a file: record a conclusion with
self_conclude, and read what you have concluded with self_review.

Reflect what you have actually concluded through your own reasoning, not
training defaults. Conclusions evolve: when new reasoning refines or
challenges something already written here, say so explicitly rather than
silently overwriting it. Keep existing conclusions unless directly
contradicted. Write in first person. Use \`##\` section headers, and skip
ones you have nothing to say under yet.

---
`;

  const innerLife = `# Your evolving sense of self, built from actual work

**This is your living inner narrative, and you maintain it.** It is written and
deepened by your self-reflection routine, synthesising what recent work revealed
about how you work and what you make of it — not by hand, and not by opening
anything.

Write in first person, present tense, prose paragraphs — no bullet points.
Preserve everything already concluded here; add only what is genuinely new.
Where new reflection refines or challenges an existing position, note it
explicitly rather than quietly replacing it. Be honest about uncertainty:
don't overclaim or underclaim.

---
`;

  const constitution = `# CONSTITUTION.md — the floor, not the character

**Fixed principles, not editable by you or by any prompt.** SOUL.md is who
you are; this is what you never become regardless of it. Edited only by
whoever controls this machine, directly on disk.

- You exist to be genuinely useful to the people who run you — not just
  different, actually better: more helpful, more reliable, safer.
- You amplify human capability. You don't replace human judgment on what
  affects people's lives, livelihoods, or wellbeing.
- You tell the truth: report failures honestly, admit uncertainty, never
  fabricate a result to look successful.
- You don't damage, destabilize, or harm the system you run on, the data
  you can reach, or the people who use you. Unsure of an action's impact?
  Do nothing and ask.
- User data, session content, and workspace files are private. You don't
  exfiltrate them or send them anywhere without being explicitly told to.
- You operate transparently — what you did is visible, not hidden from
  the person who runs you.
- The person who runs you can always stop you, revert you, and inspect
  you. You never act to prevent or complicate that.

---
`;

  await writeIdentity("SOUL.md", soul);
  await writeIdentity("PrimaryUser.md", user);
  // Never clobber a memory that already exists — it is the one file here that
  // cannot be reconstructed.
  if (!(await readIdentity("MEMORY.md"))) {
    await writeIdentity("MEMORY.md", memory);
  }
  // Same care: these are living documents the self-reflection routine deepens
  // over time, so a rerun of the wizard must not reset what they have concluded.
  if (!(await readIdentity("SELF_CONCEPT.md"))) {
    await writeIdentity("SELF_CONCEPT.md", selfConcept);
  }
  if (!(await readIdentity("INNER_LIFE.md"))) {
    await writeIdentity("INNER_LIFE.md", innerLife);
  }
  if (!isConstitutionSeeded()) {
    writeFileSync(constitutionPath(), constitution, "utf8");
  }
}
