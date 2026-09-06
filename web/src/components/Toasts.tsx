import { useEffect, useRef, useState } from "react";
import type { Session } from "../api";

/**
 * Say when something finished that you were not watching.
 *
 * A run belongs to the server, not to a request — that is the invariant the
 * portal is built on, and it has a consequence nobody had followed through:
 * work carries on while you are looking at something else, and finishes in
 * silence. The only way to find out was to go back and look, which makes the
 * fire-and-forget design feel like forgetfulness.
 *
 * Only for sessions you are not currently looking at. The open session already
 * shows its own state in every possible way — status line, transcript, task
 * panel — and a toast about the thing on screen is noise.
 */

export interface Toast {
  id: string;
  text: string;
  tone: "done" | "error";
  sessionId: string;
}

/**
 * What changed since the last poll, as toasts.
 *
 * A pure function so the rule is testable: the interesting transition is
 * running → settled, on a session that is not the one open. First render is
 * deliberately silent — everything looks like it just changed when you have
 * nothing to compare against, and a page load that announced six finished
 * sessions would be worse than saying nothing.
 */
export function newlySettled(
  previous: Map<string, string> | undefined,
  sessions: Session[],
  openSessionId: string | null,
): Toast[] {
  if (!previous) return [];
  const out: Toast[] = [];
  for (const session of sessions) {
    if (session.id === openSessionId) continue;
    const was = previous.get(session.id);
    if (was !== "running") continue;
    if (session.status === "running") continue;
    out.push({
      id: `${session.id}:${session.status}:${Date.now()}`,
      sessionId: session.id,
      tone: session.status === "error" ? "error" : "done",
      text:
        session.status === "error"
          ? `"${session.title}" stopped with an error`
          : `"${session.title}" finished`,
    });
  }
  return out;
}

export function Toasts({
  sessions,
  openSessionId,
  onOpen,
}: {
  sessions: Session[];
  openSessionId: string | null;
  onOpen: (id: string) => void;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previous = useRef<Map<string, string> | undefined>(undefined);

  useEffect(() => {
    const fresh = newlySettled(previous.current, sessions, openSessionId);
    previous.current = new Map(sessions.map((s) => [s.id, s.status]));
    if (!fresh.length) return;
    setToasts((current) => [...current, ...fresh].slice(-4));
    // Long enough to read across the room, short enough not to stack up on a
    // busy portal.
    const timer = setTimeout(() => {
      setToasts((current) => current.filter((t) => !fresh.some((f) => f.id === t.id)));
    }, 8000);
    return () => clearTimeout(timer);
  }, [sessions, openSessionId]);

  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => {
            onOpen(toast.sessionId);
            setToasts((current) => current.filter((t) => t.id !== toast.id));
          }}
          className={`pointer-events-auto max-w-xs truncate rounded-lg border px-3 py-2 text-left text-xs shadow-lg transition hover:brightness-110 ${
            toast.tone === "error"
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-border bg-surface text-fg"
          }`}
          title="Open this session"
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}
