import { useState, type ReactNode, useRef } from "react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import {
  LuBot,
  LuBrain,
  LuClock,
  LuMessagesSquare,
  LuPin,
  LuPinOff,
  LuSettings,
  LuShield,
  LuTrash2,
  LuMessageCircle,
} from "react-icons/lu";
import type { Session, SessionStatus } from "../api";
import { StatusStrip } from "./StatusStrip";

const STATUS_STYLE: Record<SessionStatus, string> = {
  running: "bg-accent animate-pulse",
  idle: "bg-fg-faint",
  error: "bg-danger",
  interrupted: "bg-warn",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "running",
  idle: "idle",
  error: "error",
  interrupted: "interrupted — server restarted mid-run",
};

/** How many unpinned sessions the sidebar shows before deferring to Sessions. */
const RECENTS_LIMIT = 12;


/** Remembered per browser; the server has no opinion about your window. */
const WIDTH_KEY = "phoenixclaw.sidebarWidth";

function storedWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw >= 180 && raw <= 520 ? raw : 256;
  } catch {
    return 256;
  }
}

export function Sidebar({
  sessions,
  executor,
  activeId,
  view,
  onSelect,
  onDelete,
  onRename,
  onPin,
  onOpenSettings,
  onNavigate,
  onOpenMain,
}: {
  sessions: Session[];
  executor: string;
  activeId: string | null;
  /** Which top-level destination is showing, so the nav can mark it. */
  view: "chat" | "sessions" | "agent" | "routines" | "audit" | "memory";
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
  onOpenSettings: () => void;
  onNavigate: (to: "sessions" | "agent" | "routines" | "audit" | "memory") => void;
  /** Open the conversation with the agent itself. */
  onOpenMain: () => void;
}) {
  const [width, setWidth] = useState(storedWidth);
  // The mouseup handler closes over the width at mousedown, so the value it
  // saves has to come from somewhere current.
  const widthRef = useRef(width);
  widthRef.current = width;

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);



  const pinned = sessions.filter((s) => s.pinned);
  const recents = sessions.filter((s) => !s.pinned);
  const shownRecents = recents.slice(0, RECENTS_LIMIT);

  const item = (s: Session) => (
    <SessionItem
      key={s.id}
      session={s}
      active={activeId === s.id}
      onSelect={() => onSelect(s.id)}
      onRename={onRename}
      onDelete={onDelete}
      onPin={onPin}
    />
  );

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width }}
    >
      <div className="flex items-center gap-2 px-3 pb-3 pt-4">
        <img
          src="/phenoixclaw-192.png"
          alt=""
          className="h-6 w-6 shrink-0 object-contain"
          draggable={false}
        />
        <h1 className="text-sm font-semibold tracking-tight text-fg">Phoenix</h1>
        <span
          className="ml-auto text-[10px] uppercase tracking-wider text-fg-faint"
          title="How sessions are executed"
        >
          {executor}
        </span>
      </div>

      {/* Destinations, above the session lists. */}
      <nav className="px-2 pb-2">
        {/*
          * First, because it is where you talk to the agent rather than about
          * it. The other destinations are views onto work; this is the thing
          * that has a self, remembers you, and decides what a request means —
          * and the only kind of session that may start tasks or write
          * routines. See /api/agent/main.
          */}
        <NavItem
          icon={<LuMessageCircle />}
          label="Chat"
          onClick={onOpenMain}
          active={false}
        />
        {/*
          * No "New" button.
          *
          * Creating a session by hand was the other way to start work, and it
          * skipped the part that matters: the agent deciding that a request
          * *is* work, giving it a brief someone who was not here could follow,
          * and planning it. Ask in Chat — `start_task` makes the session, the
          * workspace and the plan, and the sessions below are where you watch
          * it happen.
          */}
        <NavItem
          icon={<LuMessagesSquare />}
          label="Sessions"
          onClick={() => onNavigate("sessions")}
          active={view === "sessions"}
        />
        <NavItem
          icon={<LuBot />}
          label="Agent"
          onClick={() => onNavigate("agent")}
          active={view === "agent"}
        />
        <NavItem
          icon={<LuClock />}
          label="Routines"
          onClick={() => onNavigate("routines")}
          active={view === "routines"}
        />
        <NavItem
          icon={<LuBrain />}
          label="Memory"
          onClick={() => onNavigate("memory")}
          active={view === "memory"}
        />
        <NavItem
          icon={<LuShield />}
          label="Audit"
          onClick={() => onNavigate("audit")}
          active={view === "audit"}
        />

      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-fg-subtle">No sessions yet.</p>
        )}

        {pinned.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Pinned</GroupLabel>
            {pinned.map(item)}
          </>
        )}

        {shownRecents.length > 0 && (
          <>
            <Divider />
            <GroupLabel>Recents</GroupLabel>
            {shownRecents.map(item)}
            {recents.length > shownRecents.length && (
              <button
                onClick={() => onNavigate("sessions")}
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-fg-subtle hover:bg-fg/5 hover:text-fg-muted"
              >
                {recents.length - shownRecents.length} more…
              </button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-line p-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <NavItem
              icon={<LuSettings />}
              label="Settings"
              onClick={onOpenSettings}
              active={false}
            />
          </div>
          <ThemeSwitcher />
        </div>
      </div>
      {/* What the portal knows about itself — see StatusStrip. */}
      <StatusStrip />
      {/*
        * The one boundary in this layout worth moving.
        *
        * BirdClaw's TUI had three panes and splitters between them; here there
        * is a sidebar and everything else, so this is the only edge that means
        * anything. It earns its place because the sidebar's content is a list
        * of session titles, and how wide it should be depends entirely on what
        * you have called them.
        *
        * Bounded, because a sidebar dragged to nothing is a sidebar nobody can
        * find again, and the handle goes with it.
        */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = width;
          const move = (ev: MouseEvent) => {
            const next = Math.min(520, Math.max(180, startWidth + ev.clientX - startX));
            setWidth(next);
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
              localStorage.setItem(WIDTH_KEY, String(widthRef.current));
            } catch {
              // A browser that refuses storage still gets a working splitter,
              // it just forgets between visits.
            }
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
        title="Drag to resize"
      />
    </aside>
  );
}

const Divider = () => <div className="my-2 h-px bg-line" />;

const GroupLabel = ({ children }: { children: ReactNode }) => (
  <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
    {children}
  </p>
);

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        active ? "bg-fg/[0.07] text-fg" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
      }`}
    >
      <span
        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-accent transition-opacity ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <span className={`shrink-0 transition-colors ${active ? "text-accent" : "text-fg-faint group-hover:text-fg-subtle"}`}>
        {icon}
      </span>
      {label}
    </button>
  );
}

function SessionItem({
  session: s,
  active,
  onSelect,
  onRename,
  onDelete,
  onPin,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group mb-0.5 cursor-pointer rounded-lg px-2.5 py-1.5 transition ${
        active ? "bg-fg/[0.07]" : "hover:bg-fg/5"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status]}`}
          title={STATUS_LABEL[s.status]}
        />
        <span
          className="truncate text-sm text-fg"
          onDoubleClick={(e) => {
            e.stopPropagation();
            const next = prompt("Rename session", s.title);
            if (next?.trim()) onRename(s.id, next.trim());
          }}
        >
          {s.title}
        </span>

        <div className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPin(s.id, !s.pinned);
            }}
            className="rounded p-1 text-fg-subtle hover:text-accent"
            title={s.pinned ? "Unpin" : "Pin"}
          >
            {s.pinned ? <LuPinOff className="h-3 w-3" /> : <LuPin className="h-3 w-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete "${s.title}"? This stops it if it is running.`)) {
                onDelete(s.id);
              }
            }}
            className="rounded p-1 text-fg-subtle hover:text-danger"
            title="Delete session"
          >
            <LuTrash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="truncate pl-4 text-[11px] text-fg-subtle">{s.workspace.split("/").pop()}</div>
    </div>
  );
}
