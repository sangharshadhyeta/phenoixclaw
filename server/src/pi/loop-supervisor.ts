import { recentToolCalls } from "../db.js";
import { supervise, superviseBlock, dueForReview, type Supervision } from "./supervisor.js";

/**
 * Running the outer loop alongside the worker, without standing in its way.
 *
 * supervisor.ts decides *what* to say; this decides *when*, and the answer has
 * to be "not on the critical path". A judgement that costs the worker a whole
 * model call of latency before every request would make every session slower to
 * buy an opinion that changes slowly — so the review runs in the background and
 * its verdict is applied to the *next* request. At most one call stale, which
 * for "are you going in the right direction" is not stale at all.
 *
 * The one thing that is not deferred is repetition, because it needs no model:
 * a string comparison over the last few calls, run inline, catching the case
 * where the worker is about to make the same call a fourth time.
 *
 * State is per-session and in memory on purpose, and it is the kind that may be
 * lost: it is a counter and a cached opinion, not part of the run. A restart
 * mid-session loses the last verdict and forms another within four tool calls,
 * which is why this is not in the database — the run belongs to the server, but
 * an opinion about the run does not have to survive it.
 */

/** Long enough for a slow local model, short enough that a hang is not permanent. */
const REVIEW_TIMEOUT_MS = Number(process.env.SUPERVISOR_TIMEOUT_MS || 90_000);

interface Watch {
  callsAtLastReview: number;
  verdict?: Supervision;
  reviewing: boolean;
}

const watches = new Map<string, Watch>();

/** Forget a session's supervision. Called when its conversation is retired. */
export function forgetSupervision(sessionId: string): void {
  watches.delete(sessionId);
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as any).text ?? "") : ""))
      .join(" ");
  }
  return "";
};

function messagesOf(payload: unknown): any[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.every((m) => typeof m === "object" && m !== null && typeof (m as any).role === "string")
    ? messages
    : undefined;
}

/** The request the worker is actually working on — the most recent thing a person said. */
function lastRequest(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOf(messages[i].content);
  }
  return "";
}

export function loopSupervisor(
  sessionId: string | undefined,
  deps: {
    calls?: (id: string) => Promise<Array<{ toolName: string; args: string }>>;
    review?: (id: string, request: string) => Promise<Supervision | undefined>;
  } = {},
) {
  return (pi: any): void => {
    if (!sessionId) return;
    const readCalls = deps.calls ?? ((id: string) => recentToolCalls(id, 20));
    const review = deps.review ?? ((id: string, request: string) => supervise(id, request));

    pi.on("before_provider_request", async (event: any) => {
      const payload = event?.payload;
      const messages = messagesOf(payload);
      if (!messages) return undefined;

      const watch = watches.get(sessionId) ?? { callsAtLastReview: 0, reviewing: false };
      watches.set(sessionId, watch);

      let calls: Array<{ toolName: string; args: string }> = [];
      try {
        calls = await readCalls(sessionId);
      } catch {
        return undefined;
      }

      // Start the next review in the background if enough has happened. Its
      // verdict lands on a later request; nothing here waits for it.
      if (!watch.reviewing && dueForReview(calls.length, watch.callsAtLastReview)) {
        watch.reviewing = true;
        watch.callsAtLastReview = calls.length;
        /**
         * The in-flight flag has to clear even if the review never does.
         *
         * `reviewing` is what stops two reviews overlapping, so a call that
         * hangs — an unreachable model, a socket that neither answers nor
         * closes — would leave it set for the life of the session and silently
         * turn the supervisor off. Not a crash, not a log line: just a session
         * that quietly stops being watched, which is the failure you find
         * months later. A verdict that took this long is stale anyway.
         */
        void Promise.race([
          review(sessionId, lastRequest(messages)),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), REVIEW_TIMEOUT_MS).unref?.()),
        ])
          .then((verdict) => {
            if (verdict) watch.verdict = verdict;
          })
          .catch(() => {
            // A supervisor that cannot reach its model must not stop the work
            // it was supervising.
          })
          .finally(() => {
            watch.reviewing = false;
          });
      }

      const block = superviseBlock(watch.verdict);
      if (!block) return undefined;
      // Shown once. A note repeated on every request stops reading as a
      // judgement and starts reading as wallpaper — and the worker has either
      // acted on it or decided not to by the time it is asked again.
      watch.verdict = undefined;

      const first = messages[0];
      if (!first || first.role !== "system") {
        return { ...(payload as object), messages: [{ role: "system", content: block }, ...messages] };
      }
      return {
        ...(payload as object),
        messages: [{ ...first, content: `${textOf(first.content)}\n${block}` }, ...messages.slice(1)],
      };
    });
  };
}
