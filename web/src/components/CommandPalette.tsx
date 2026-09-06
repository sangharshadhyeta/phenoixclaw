import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session } from "../api";

/**
 * One key for everything.
 *
 * The portal grew a page at a time — sessions, routines, memory, audit,
 * settings — each reachable by finding the right thing in the sidebar and
 * clicking it. That is fine at three pages and tiring at eight, and it is
 * hopeless for sessions, where the thing you want is a name you remember and
 * the sidebar shows you the most recent dozen.
 *
 * BirdClaw's TUI answered this with keys, which do not translate: a browser
 * already spends its shortcuts. A palette does translate, and subsumes the
 * quick-switcher and the jump-to-page list that would otherwise be two more
 * things to build.
 */

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Match on any word in any order — "mem gra" finds "Memory graph". */
function matches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  extra = [],
}: {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  /** Anything the current view wants to offer — see Chat's builtins. */
  extra?: Command[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focused on the next frame: the input does not exist yet on this one.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = [
      { id: "p:chat", label: "Conversation", hint: "the agent's own", run: () => navigate("/") },
      { id: "p:sessions", label: "Sessions", run: () => navigate("/sessions") },
      { id: "p:agent", label: "Agent", run: () => navigate("/agent") },
      { id: "p:routines", label: "Routines", run: () => navigate("/routines") },
      { id: "p:memory", label: "Memory", hint: "what it knows", run: () => navigate("/memory") },
      { id: "p:audit", label: "Audit", hint: "what it did", run: () => navigate("/audit") },
      { id: "p:settings", label: "Settings", run: () => navigate("/settings") },
    ];
    const jumps: Command[] = sessions.map((s) => ({
      id: `s:${s.id}`,
      label: s.title,
      hint: s.workspace,
      run: () => navigate(`/s/${s.id}`),
    }));
    return [...extra, ...pages, ...jumps];
  }, [navigate, sessions, extra]);

  const shown = useMemo(
    () =>
      (query
        ? commands.filter((c) => matches(`${c.label} ${c.hint ?? ""}`, query))
        : commands
      ).slice(0, 12),
    [commands, query],
  );

  useEffect(() => setCursor(0), [query]);
  if (!open) return null;

  const choose = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") return onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(shown[cursor]);
            }
          }}
          placeholder="Jump to a session, a page, or run a command…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-faint"
        />
        <div className="max-h-80 overflow-auto py-1">
          {shown.length === 0 && (
            <div className="px-4 py-3 text-xs text-fg-faint">Nothing matches “{query}”.</div>
          )}
          {shown.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(c)}
              className={`flex w-full items-baseline gap-2 px-4 py-2 text-left text-xs ${
                i === cursor ? "bg-fg/5 text-fg" : "text-fg-muted"
              }`}
            >
              <span className="truncate">{c.label}</span>
              {c.hint && <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
