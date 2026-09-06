import { LuPanelLeftOpen } from "react-icons/lu";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type PortalEvent, type Session, type Workspace } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { MemoryPage } from "./components/MemoryPage";
import { Login } from "./components/Login";
import { CommandPalette } from "./components/CommandPalette";
import { Toasts } from "./components/Toasts";
import { ConfigModal } from "./components/ConfigModal";
import { ExtensionDialog, type UiRequest } from "./components/ExtensionDialog";
import { SessionsPage } from "./components/SessionsPage";
import { AgentPage } from "./components/AgentPage";
import { RoutinesPage } from "./components/RoutinesPage";
import { AuditPage } from "./components/AuditPanel";
import { ThemeSwitcher } from "./components/ThemeSwitcher";

// Legacy routes ("session", "global") still resolve — old links stay valid.
type Tab = "general" | "extensions" | "advanced";
const LEGACY_TABS: Record<string, Tab> = { session: "general", global: "general" };

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">Loading…</div>
    );
  }
  if (!authed) {
    return (
      <>
        <div className="fixed right-4 top-4 z-10">
          <ThemeSwitcher />
        </div>
        <Login onSuccess={() => setAuthed(true)} />
      </>
    );
  }

  // Every meaningful view has a URL: a session, and its settings tabs. Deep
  // links and the back button work, and the server's SPA fallback serves them.
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/sessions" element={<Shell view="sessions" />} />
      <Route path="/agent" element={<Shell view="agent" />} />
      <Route path="/routines" element={<Shell view="routines" />} />
      <Route path="/audit" element={<Shell view="audit" />} />
      <Route path="/memory" element={<Shell view="memory" />} />
      <Route path="/s/:sessionId" element={<Shell />} />
      <Route path="/s/:sessionId/settings" element={<Shell settings />} />
      <Route path="/s/:sessionId/settings/:tab" element={<Shell settings />} />
      <Route path="/settings" element={<Shell settings />} />
      <Route path="/settings/:tab" element={<Shell settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Shell({
  settings = false,
  view = "chat",
}: {
  settings?: boolean;
  view?: "chat" | "sessions" | "agent" | "routines" | "audit" | "memory";
}) {
  const { sessionId, tab } = useParams<{ sessionId?: string; tab?: string }>();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [executor, setExecutor] = useState("host");
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uiQueue, setUiQueue] = useState<UiRequest[]>([]);
  const esRef = useRef<EventSource | null>(null);
  /**
   * Whether the event stream is actually connected.
   *
   * It reconnects itself every two seconds on failure, so a portal that has
   * gone away looks exactly like one that is quiet — the transcript simply
   * stops, with nothing to say whether the agent finished or the connection
   * dropped. Those need to look different.
   */
  const [connected, setConnected] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * Whether the sidebar is out of the way, remembered per browser.
   *
   * Here rather than in Sidebar because the button that brings it back has to
   * live somewhere still on screen — a toggle inside the thing it hides is a
   * trap.
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("phoenix.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      try {
        localStorage.setItem("phoenix.sidebarCollapsed", v ? "0" : "1");
      } catch {
        // A browser that refuses storage still toggles; it just forgets.
      }
      return !v;
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    setSessions(r.sessions);
    setExecutor(r.executor);
    return r.sessions;
  }, []);

  useEffect(() => {
    refreshSessions()
      .then(async (list) => {
        // Only "/" redirects. The Sessions and Agents pages have no sessionId
        // either, and without the view check they were redirected away the
        // moment they loaded.
        if (sessionId || settings || view !== "chat") return;

        /**
         * Land in the agent's own conversation, not the newest task.
         *
         * That conversation is where everything the agent does now shows up —
         * routines on their own initiative and task sessions alike (see
         * mirror.ts). Opening the most recent task instead put the narrowest
         * view in front of you by default and left the whole picture somewhere
         * you had to go looking for.
         *
         * Falls back to the newest task if the main conversation cannot be
         * reached, because landing somewhere is better than landing nowhere.
         */
        try {
          const { id } = await api.mainConversation();
          navigate(`/s/${id}`, { replace: true });
        } catch {
          if (list[0]) navigate(`/s/${list[0].id}`, { replace: true });
        }
      })
      .catch((e) => setError(String(e)));
    api
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch(() => {});
    const t = setInterval(() => refreshSessions().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [refreshSessions, sessionId, settings, view, navigate]);

  /**
   * ⌘K / Ctrl-K anywhere.
   *
   * Bound on the window rather than a container so it works wherever focus
   * happens to be, and it deliberately does not fire while typing into the
   * composer — the one place a shortcut stealing a keystroke is most annoying
   * is mid-sentence.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "TEXTAREA";
      if (typing && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setUiQueue([]);
    if (!sessionId) return;

    let cancelled = false;
    let seq = 0;
    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      esRef.current = es;
      es.onopen = () => setConnected(true);
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // Live-only events (dialogs) use a negative seq and must not move the
        // resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "portal_status") refreshSessions().catch(() => {});
        // Dialogs an extension is blocking on. notify/setStatus/setWidget are
        // one-way and must not open a modal.
        if (ev.type === "extension_ui_request") {
          const req = ev.payload as UiRequest;
          if (["select", "confirm", "input", "editor"].includes(req.method)) {
            setUiQueue((q) => (q.some((x) => x.id === req.id) ? q : [...q, req]));
          }
        }
        if (ev.type === "extension_ui_cancel") {
          const id = (ev.payload as { id: string }).id;
          setUiQueue((q) => q.filter((x) => x.id !== id));
        }
      };
      es.onerror = () => {
        setConnected(false);
        es.close();
        setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [sessionId, refreshSessions]);

  // The task list deliberately excludes agent and routine sessions, but their
  // URLs still have to open — the Agent and Routines pages link straight to
  // them, and without this those links landed on the empty state.
  const [other, setOther] = useState<Session | null>(null);
  const listed = sessions.find((s) => s.id === sessionId) ?? null;

  useEffect(() => {
    if (!sessionId || listed) return setOther(null);
    let cancelled = false;
    api
      .session(sessionId)
      .then((s) => !cancelled && setOther(s))
      .catch(() => !cancelled && setOther(null));
    return () => {
      cancelled = true;
    };
  }, [sessionId, listed]);

  const active = listed ?? (other?.id === sessionId ? other : null);

  return (
    <div className="flex h-screen bg-canvas">
      {/* Work finishes whether or not its tab is open — see Toasts. */}
      <Toasts
        sessions={sessions}
        openSessionId={sessionId ?? null}
        onOpen={(id) => navigate(`/s/${id}`)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
      />
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        executor={executor}
        activeId={sessionId ?? null}
        view={view}
        onNavigate={(to) => navigate(`/${to}`)}
        onOpenMain={async () => {
          // Created on first use, so this is also what brings it into being.
          const main = await api.mainConversation();
          navigate(`/s/${main.id}`);
        }}
        onSelect={(id) => navigate(`/s/${id}`)}
        onDelete={async (id) => {
          await api.deleteSession(id);
          const list = await refreshSessions();
          if (sessionId === id) navigate(list[0] ? `/s/${list[0].id}` : "/", { replace: true });
        }}
        onRename={async (id, title) => {
          await api.renameSession(id, title);
          refreshSessions();
        }}
        onPin={async (id, pinned) => {
          await api.pinSession(id, pinned);
          refreshSessions();
        }}
        onOpenSettings={() =>
          navigate(sessionId ? `/s/${sessionId}/settings/general` : "/settings/general")
        }
      />

      {/*
        * The way back, from anywhere.
        *
        * Chat's header has its own toggle for hiding, but it is a chat header:
        * collapse the sidebar and open Memory or Routines and there would be
        * nothing to click. This one is rendered for every view, and only while
        * the sidebar is hidden, so there is never a second button competing
        * with the first.
        */}
      {sidebarCollapsed && (
        <button
          onClick={toggleSidebar}
          className="fixed left-2 top-2 z-40 rounded-lg bg-surface/90 p-1.5 text-fg-subtle shadow ring-1 ring-inset ring-line transition hover:text-fg"
          title="Show the sidebar"
          aria-label="Show the sidebar"
        >
          <LuPanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {error && <div className="bg-danger/10 px-4 py-2 text-sm text-danger">{error}</div>}
        {view === "sessions" ? (
          <SessionsPage
            sessions={sessions}
            onSelect={(id) => navigate(`/s/${id}`)}
            onDelete={async (id) => {
              await api.deleteSession(id);
              await refreshSessions();
            }}
            onPin={async (id, pinned) => {
              await api.pinSession(id, pinned);
              refreshSessions();
            }}
          />
        ) : view === "agent" ? (
          <AgentPage onSelect={(id) => navigate(`/s/${id}`)} />
        ) : view === "routines" ? (
          <RoutinesPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "audit" ? (
          <AuditPage />
        ) : view === "memory" ? (
          <MemoryPage />
        ) : active ? (
          <Chat
            session={active}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            events={events}
            connected={connected}
            onSend={async (msg) => {
              await api.prompt(active.id, msg);
              refreshSessions();
            }}
            onAbort={async () => {
              await api.abort(active.id);
              refreshSessions();
            }}
            onClientCommand={async (name, args) => {
              if (name === "settings") {
                navigate(`/s/${active.id}/settings/general`);
              } else if (name === "new") {
                const s = await api.createSession(active.workspace);
                await refreshSessions();
                navigate(`/s/${s.id}`);
              } else if (name === "name" && args.trim()) {
                await api.renameSession(active.id, args.trim());
                refreshSessions();
              }
            }}
          />
        ) : (
          <OpenChat />
        )}
      </main>

      {active && uiQueue[0] && (
        <ExtensionDialog
          sessionId={active.id}
          request={uiQueue[0]}
          onDone={() => setUiQueue((q) => q.slice(1))}
        />
      )}

      {settings && (
        <ConfigModal
          initialTab={LEGACY_TABS[tab ?? ""] ?? (tab as Tab) ?? "general"}
          onClose={() => navigate(active ? `/s/${active.id}` : "/")}
        />
      )}
    </div>
  );
}

/**
 * There is no empty state; there is the conversation.
 *
 * This used to be a placeholder saying "start a session to get going", which
 * was wrong twice over: the button it pointed at is gone, and starting a
 * session is not the person's decision — they ask, and the agent decides
 * whether the request is work. So anywhere that would have shown nothing shows
 * the chat instead, which always takes input.
 *
 * Reached in two ways: the moment before the initial redirect lands, and a
 * session id that no longer exists — a deleted session, or a stale bookmark.
 * Both want the same thing.
 */
function OpenChat() {
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    api
      .mainConversation()
      .then(({ id }) => {
        if (alive) navigate(`/s/${id}`, { replace: true });
      })
      .catch(() => {
        // The conversation is created on first ask, so this only fails when
        // the portal itself is unreachable — and the error banner says so.
      });
    return () => {
      alive = false;
    };
  }, [navigate]);
  return null;
}
