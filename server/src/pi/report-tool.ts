import { Type } from "typebox";
import { getDb, getDefaultReportTo, type ReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import type { RoutineRow } from "../routines/supervisor.js";

/**
 * Reporting back from a routine.
 *
 * A routine runs with nobody watching: its account of what it did lands in
 * `last_output`, which is only seen by someone who goes looking. This is the
 * way out — the agent decides a run is worth telling you about and says so
 * through a channel you already use.
 *
 * The agent chooses *whether* and *what*; it does not choose *where*. The
 * destination is configuration, so a routine cannot start messaging somewhere
 * it was never pointed at.
 */

/**
 * A routine's own destination, or the portal default.
 *
 * NULL inherits. An empty string is an explicit "this one never reports", which
 * is why it is distinguished from NULL rather than treated as unset.
 */
export async function reportToFor(slug: string | null | undefined): Promise<ReportTo | null> {
  if (!slug) return getDefaultReportTo();
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT * FROM routines WHERE slug = $slug", { slug });
  const row = reader.getRowObjectsJson()[0] as unknown as RoutineRow | undefined;
  if (!row) return getDefaultReportTo();
  if (row.report_channel === "") return null;
  if (row.report_channel && row.report_target) {
    return { channel: row.report_channel, target: row.report_target };
  }
  return getDefaultReportTo();
}

/**
 * What the routine prompt says about reporting, or nothing when it cannot.
 *
 * The first version of this sat next to "finish with a short account of what you
 * did", and the model kept satisfying that by writing the account as text and
 * never calling the tool — it had no way to know that text is stored and read by
 * nobody. Saying so explicitly is the difference between the tool being used and
 * being ignored.
 */
export function reportFraming(to: ReportTo | null): string {
  if (!to) return "";
  return [
    "That account is filed and read by nobody. Calling the report tool is the only",
    `way anything reaches a person — it sends to the "${to.channel}" channel.`,
    "So: if this run turned up something worth knowing — what you found, what you",
    "changed, anything that needs a decision — end by calling report. Writing it out",
    "instead is the same as saying nothing.",
    "Skip the call when the run really was uneventful: a report that says nothing",
    "happened trains people to ignore the next one.",
  ].join("\n");
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function reportTool(routineSlug: string | null) {
  return (pi: any): void => {
    pi.registerTool({
      name: "report",
      label: "Report back",
      description:
        "Send a message to the human who set this routine up, through the channel it reports to. " +
        "Use it for something worth their attention: what you found, what you changed, a decision " +
        "you need. It is one-way — you will not get a reply, so do not ask questions.",
      promptSnippet: "report — tell the human something worth knowing about this run",
      parameters: Type.Object({
        message: Type.String({ description: "What to say. Written for someone who was not here." }),
      }),
      async execute(_id: string, p: any) {
        const to = await reportToFor(routineSlug);
        if (!to) throw new Error("Nowhere to report to — no destination is configured.");
        const message = String(p.message ?? "").trim();
        if (!message) throw new Error("Nothing to send.");
        try {
          await channelSupervisor.send(to.channel, to.target, message);
          if (routineSlug) {
            const conn = await getDb();
            await conn.run(
              "UPDATE routines SET last_report_at = $now WHERE slug = $slug",
              { now: new Date().toISOString(), slug: routineSlug },
            );
          }
          return { content: [{ type: "text" as const, text: `Sent to ${to.channel}.` }], details: {} };
        } catch (e) {
          throw new Error(`Could not send: ${(e as Error).message}`);
        }
      },
    });
  };
}
