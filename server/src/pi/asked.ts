/**
 * What the person actually said, with the portal's own additions taken off.
 *
 * A prompt does not reach pi as it was typed. The portal appends pre-turn
 * notes (`# THERE IS ARITHMETIC IN THIS`, `# BEFORE YOU START`, …), wraps its
 * own instructions in `<portal-check>` / `<portal-result>` / `<portal-notice>`
 * blocks, and hands back check text — all of it addressed to the model, none
 * of it said by anybody.
 *
 * The memory injector was searching with the whole thing. Asked "what is the
 * square root of 144?", the recall query was that question *plus* the
 * arithmetic note — three paragraphs about 17 times 23, 393 and 391 — so what
 * came back was matched against our own boilerplate rather than the question.
 * The turn was handed `first 20 primes` and a fact node named `25`, left over
 * from a previous `100/4`, while it was trying to produce a number. Memory
 * that answers the note instead of the question is worse than no memory: it is
 * confidently about the wrong thing.
 *
 * Used for retrieval only. What the model *reads* is still the full text —
 * the notes are there to be obeyed, they are just not what the memory is
 * about.
 */

/** Headings the portal appends. Everything from one of these on is ours. */
const APPENDED_HEADING = /^#\s+(?:THERE IS\b|THIS ASKS\b|BEFORE YOU START\b|WHAT YOU HAVE SINCE\b|YOUR MEMORY OF THIS\b|WHAT IS RUNNING\b)/im;

/** Blocks the portal wraps its own instructions in, with their contents. */
const PORTAL_BLOCK = /<portal-[a-z-]+>[\s\S]*?<\/portal-[a-z-]+>/gi;

/** An unclosed opener still marks where our text begins. */
const PORTAL_OPENER = /<portal-[a-z-]+>/i;

/** Untrusted-content markers wrap someone else's words — see guard.ts. */
const TAINT_MARKER = /<<<untrusted:[^>]*>>>/gi;

export function asked(message: string): string {
  let text = String(message ?? "").replace(PORTAL_BLOCK, " ").replace(TAINT_MARKER, " ");

  const opener = PORTAL_OPENER.exec(text);
  if (opener) text = text.slice(0, opener.index);

  const heading = APPENDED_HEADING.exec(text);
  if (heading) text = text.slice(0, heading.index);

  const trimmed = text.trim();
  /**
   * If stripping left nothing, the message *was* ours — a hand-back, a
   * delivered result. Fall back to the original rather than searching on an
   * empty string, which matches everything and ranks by nothing.
   */
  return trimmed || String(message ?? "").trim();
}
