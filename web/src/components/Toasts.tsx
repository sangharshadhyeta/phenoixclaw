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

/** How long a toast stays up before it clears itself. */
const LIFETIME_MS = 8000;

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
  // One timer per toast, not one for the whole batch — a toast added a poll
  // tick later must not vanish early just because an earlier one's timer
  // fired first, and dismissing one by hand must not touch the others' clocks.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  };

  useEffect(() => {
    const fresh = newlySettled(previous.current, sessions, openSessionId);
    previous.current = new Map(sessions.map((s) => [s.id, s.status]));
    if (!fresh.length) return;
    setToasts((current) => [...current, ...fresh].slice(-4));
    // Long enough to read across the room, short enough not to stack up on a
    // busy portal.
    for (const toast of fresh) {
      timers.current.set(
        toast.id,
        setTimeout(() => dismiss(toast.id), LIFETIME_MS),
      );
    }
  }, [sessions, openSessionId]);

  // Every timer this component owns is cleared on unmount, not left running
  // against state that no longer exists.
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="button"
          tabIndex={0}
          onClick={() => {
            onOpen(toast.sessionId);
            dismiss(toast.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              onOpen(toast.sessionId);
              dismiss(toast.id);
            }
          }}
          title="Open this session"
          className={`pointer-events-auto relative max-w-xs cursor-pointer overflow-hidden rounded-lg border shadow-lg transition hover:brightness-110 ${
            toast.tone === "error"
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-border bg-surface text-fg"
          }`}
        >
          <div className="flex items-center gap-2 px-3 py-2 pr-7 text-left text-xs">
            <span className="truncate">{toast.text}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(toast.id);
            }}
            className="absolute right-1 top-1 rounded p-1 text-fg-faint transition hover:bg-fg/10 hover:text-fg"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
          {/* The timer, as a shrinking bar rather than a number — visible at a
              glance, and a CSS transition needs no per-frame JS to animate. */}
          <div
            key={`${toast.id}-bar`}
            className={`absolute bottom-0 left-0 h-0.5 w-full ${
              toast.tone === "error" ? "bg-danger/50" : "bg-accent/50"
            }`}
            style={{
              animation: `toast-countdown ${LIFETIME_MS}ms linear forwards`,
              transformOrigin: "left",
            }}
          />
        </div>
      ))}
      <style>{`
        @keyframes toast-countdown {
          from { transform: scaleX(1); }
          to { transform: scaleX(0); }
        }
      `}</style>
    </div>
  );
}
