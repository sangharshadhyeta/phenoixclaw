/**
 * A step has to be followable by someone who was not there.
 *
 * Sisyphean's decomposer put this as a writing rule with two examples:
 *
 *     BAD:  "Continue the previous work"
 *     GOOD: "Run `python scraper.py --url …` and check stdout for ≥5 titles"
 *
 * and its docstring claimed something stronger than it sounds — *"context loss
 * is architecturally impossible: there is no context to lose"*. The feature
 * audit kept the machinery question (up-front decomposition, `needs_prev`
 * plumbing: small-model scaffolding, correctly dropped) and lost the rule.
 *
 * The rule outlives the model, and this port made it load-bearing rather than
 * merely good practice. Each step now runs in a context of its own holding the
 * plan and what earlier steps produced — so the step's own text really is most
 * of what the next turn has. "Continue the refactor" was recoverable when the
 * whole conversation was still there. It is not recoverable now, and it fails
 * silently: the model writes something plausible for a step it cannot resolve.
 *
 * ## Why this warns rather than refuses
 *
 * The detection is a word list, and a word list cannot tell "continue the
 * refactor" from "add a Continue button". Refusing on that would block real
 * plans over a false positive, and the cost of the false negative is one
 * vaguer step in a plan the model can still revise. Same judgement as
 * write_plan's research nudge: say what you see, at the moment the decision is
 * being made, and leave it there.
 */

/**
 * Phrases that only mean something to a reader who has the earlier steps in
 * front of them. Deliberately short: every addition trades a caught vague step
 * for a false positive on an ordinary sentence.
 */
const BACK_REFERENCES: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(continue|carry on|resume|pick up)\b(?!\s+(button|link|integration))/i, why: "continue what?" },
  { pattern: /\bthe (previous|prior|last|earlier|preceding) (step|one|work|task|section|part)\b/i, why: "which one?" },
  { pattern: /\b(as|same) (above|before|previously|earlier)\b/i, why: "as what?" },
  { pattern: /\bfinish (it|them|this|that|the rest)\b/i, why: "finish what?" },
  { pattern: /\b(do|repeat) (the same|likewise|similarly)\b/i, why: "the same as what?" },
  { pattern: /^\s*(and|then|also|next),?\s/i, why: "this reads as a continuation of a sentence that is not there" },
];

export interface VagueStep {
  index: number;
  text: string;
  why: string;
}

/** Steps that will not make sense on their own. Empty when the plan is sound. */
export function backReferences(steps: string[]): VagueStep[] {
  const found: VagueStep[] = [];
  steps.forEach((text, i) => {
    for (const { pattern, why } of BACK_REFERENCES) {
      if (pattern.test(text)) {
        found.push({ index: i + 1, text, why });
        break;
      }
    }
  });
  return found;
}

/** What to say about them. Empty when there is nothing to say. */
export function selfContainmentNote(steps: string[]): string {
  const vague = backReferences(steps);
  if (!vague.length) return "";
  return (
    `\n\nOne thing about the wording. Each step is carried out in a context of its own — it gets ` +
    `this plan and what the earlier steps produced, not the conversation you are having now. So a ` +
    `step has to make sense to someone who was not here:\n\n` +
    vague.map((v) => `  [${v.index}] "${v.text}" — ${v.why}`).join("\n") +
    `\n\nSay what to do, specifically: "run \`npm test -w server\` and fix what fails" rather than ` +
    `"continue the work". Call the tool again with better wording if these would not stand alone; ` +
    `if they read fine to you as they are, carry on.`
  );
}
