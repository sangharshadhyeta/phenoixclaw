/**
 * Tell the agent when *now* is, every turn.
 *
 * Nothing did. pi puts no date in its system prompt and neither did the portal,
 * so the agent inferred one from whatever timestamps its memory happened to
 * carry — asked directly, it answered "Friday, September 5, 2026" on Sunday the
 * 6th, having picked up yesterday's date from a conversation node and guessed
 * the weekday wrong on top.
 *
 * Every temporal question depends on this. "You have a meeting on Thursday" is
 * useless without knowing whether that Thursday has been and gone; "last week",
 * "tomorrow", "still" and "yet" cannot be reasoned about at all. An agent whose
 * memory has timestamps but whose present has none can order its past and
 * cannot locate itself in it.
 *
 * Per turn rather than per session, deliberately: this is set at
 * `before_agent_start`, so a conversation left open overnight is told the new
 * date on its next message instead of insisting it is still yesterday.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Resolve a weekday name to the next date on or after `from`. */
export function nextWeekday(from: Date, weekday: number): Date {
  const out = new Date(from);
  const delta = (weekday - from.getDay() + 7) % 7;
  out.setDate(out.getDate() + (delta === 0 ? 7 : delta));
  return out;
}

/** The block that says when now is, and how to read a bare weekday. */
export function nowBlock(now = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const day = DAYS[now.getDay()];
  const time = now.toISOString().slice(11, 16);

  // The coming week, named, so "Thursday" needs no arithmetic to place — and
  // so a memory that says "Thursday" can be compared against a real date
  // rather than a word.
  const week = DAYS.map((_, i) => i)
    .filter((i) => i !== now.getDay())
    .map((i) => {
      const d = nextWeekday(now, i);
      return `${DAYS[i]} ${d.toISOString().slice(0, 10)}`;
    })
    .join(", ");

  return [
    "",
    "# TODAY",
    "",
    `It is ${day}, ${iso}, ${time} UTC.`,
    "",
    `The next of each weekday: ${week}.`,
    "",
    "Your memories carry the date they were recorded. Use it: something said on a",
    "date now past is not still ahead, and a day of the week mentioned in an old",
    "memory belongs to that memory's own week, not to this one. If a memory says",
    "an event was coming and its date has since passed, say so rather than",
    "repeating it as though it were still to come. If you cannot tell, say which",
    "date you would need.",
  ].join("\n");
}

export function temporalContext(clock: () => Date = () => new Date()) {
  return (pi: any): void => {
    pi.on("before_agent_start", async (event: any) => ({
      systemPrompt: `${String(event?.systemPrompt ?? "")}\n${nowBlock(clock())}`,
    }));
  };
}
