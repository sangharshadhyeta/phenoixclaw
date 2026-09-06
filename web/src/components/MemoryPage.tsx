import { useEffect, useState } from "react";
import { LuBrain, LuSearch } from "react-icons/lu";
import { api, type MemoryNode, type Neighbor } from "../api";
import { MemoryGraph } from "./MemoryGraph";

/**
 * What the agent knows.
 *
 * Every other view shows what it did; this is what it took away. Worth having
 * its own page now that the learning loop writes here unattended — a memory
 * nobody looks at is a memory nobody can correct, and a loop is perfectly
 * capable of recording the same conclusion all day in slightly different
 * words. Seeing that takes one glance at a list and no glances at a transcript.
 *
 * Read-only, deliberately. The agent writes this, and a fact edited behind its
 * back is one it will re-derive and be confused by. If something here is
 * wrong, telling it is both the fix and how you find out why it believed it.
 */

/** Grouped by what they are for, since the types mean quite different things. */
const TYPE_LABEL: Record<string, string> = {
  anchor: "identity",
  user: "about you",
  project: "projects",
  concept: "concepts",
  fact: "facts",
  skill: "skills",
  episode: "episodes",
  workspace_note: "workspace notes",
  page: "pages read",
  tool_cache: "cached reads",
};

/** Confidence as a word. A bare 0.63 says less than "corroborated" does. */
function standing(n: MemoryNode): { text: string; cls: string } {
  if (n.type === "anchor") return { text: "fixed", cls: "text-accent" };
  if (n.confidence >= 0.8) return { text: "well established", cls: "text-ok" };
  if (n.confidence >= 0.55) return { text: "corroborated", cls: "text-fg-muted" };
  if (n.confidence >= 0.45) return { text: "believed", cls: "text-fg-subtle" };
  return { text: "extracted", cls: "text-fg-faint" };
}

const when = (iso: string) => {
  const t = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").getTime();
  const mins = Math.round((Date.now() - t) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export function MemoryPage() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [data, setData] = useState<{ total: number; counts: Record<string, number>; nodes: MemoryNode[] }>({
    total: 0,
    counts: {},
    nodes: [],
  });
  const [open, setOpen] = useState<string | null>(null);
  const [links, setLinks] = useState<Neighbor[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * A list answers "does it know X"; a picture answers "how is this connected".
   * Both are wanted and neither replaces the other, so they are tabs rather
   * than one view trying to be both.
   */
  const [view, setView] = useState<"list" | "graph">("list");

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    // Debounced: the query runs an embedding search, which is not free.
    const t = setTimeout(() => {
      api
        .memory(q, type)
        .then((d) => !cancelled && setData(d))
        .catch(() => {})
        .finally(() => !cancelled && setBusy(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, type]);

  const expand = async (name: string) => {
    if (open === name) return setOpen(null);
    setOpen(name);
    setLinks([]);
    try {
      setLinks(await api.memoryNeighbors(name));
    } catch {
      /* a node with no edges is the common case, not an error */
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center gap-2">
            <LuBrain className="text-fg-muted" size={16} />
            <h2 className="text-sm font-medium text-fg">Memory</h2>
            <span className="text-[11px] text-fg-faint">{data.total} things known</span>
          </div>
          <p className="mt-1 text-xs text-fg-subtle">
            What the agent has taken away from its work. It writes this itself — if something here is
            wrong, tell it, or forget it here and let it learn the right thing.
          </p>

          <div className="mt-3 flex gap-1">
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-lg px-2.5 py-1 text-xs transition ${
                  view === v ? "bg-fg/10 text-fg" : "text-fg-muted hover:bg-fg/5"
                }`}
              >
                {v === "list" ? "List" : "Connections"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1">
              <LuSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" size={13} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search what it knows…"
                className="w-full rounded-lg border border-line bg-raised/60 py-1.5 pl-8 pr-2 text-sm text-fg placeholder:text-fg-faint"
              />
            </div>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="rounded-lg border border-line bg-raised/60 px-2 py-1.5 text-xs text-fg-muted"
            >
              <option value="">everything</option>
              {Object.entries(data.counts).map(([t, n]) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t] ?? t} ({n})
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {view === "graph" ? (
        // The search box stays above, but filtering a picture by keyword makes
        // a picture of nothing — the graph has its own type filter instead.
        <MemoryGraph onSelect={(name) => { setView("list"); setQ(name); }} />
      ) : (
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-1.5">
          {!data.nodes.length && (
            <p className="pt-12 text-center text-sm text-fg-subtle">
              {busy ? "Looking…" : q ? "Nothing matches that." : "It has not learned anything yet."}
            </p>
          )}

          {data.nodes.map((n) => {
            const s = standing(n);
            return (
              <div key={n.id} className="rounded-lg border border-line bg-surface/40">
                <button
                  type="button"
                  onClick={() => expand(n.name)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-fg/5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm text-fg">{n.name}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-faint">
                        {TYPE_LABEL[n.type] ?? n.type}
                      </span>
                    </div>
                    {n.summary && n.summary !== n.name && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{n.summary}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`text-[10px] ${s.cls}`}>{s.text}</div>
                    <div className="text-[10px] text-fg-faint">
                      {n.observations > 1 ? `seen ${n.observations}× · ` : ""}
                      {when(n.last_seen)}
                    </div>
                  </div>
                </button>

                {open === n.name && (
                  <div className="border-t border-line px-3 py-2">
                    {links.length ? (
                      <ul className="space-y-0.5">
                        {links.map((l, i) => (
                          <li key={i} className="text-[11px] text-fg-subtle">
                            {l.direction === "out" ? (
                              <>
                                <span className="text-fg-faint">{n.name}</span> {l.relation}{" "}
                                <span className="text-fg-muted">{l.name}</span>
                              </>
                            ) : (
                              <>
                                <span className="text-fg-muted">{l.name}</span> {l.relation}{" "}
                                <span className="text-fg-faint">{n.name}</span>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-fg-faint">Not connected to anything yet.</p>
                    )}

                    {/*
                      * Reading the graph without being able to correct it is
                      * half a window. The agent has graph_forget for a belief
                      * it notices is wrong; this is the same for a belief you
                      * notice. Identity and projects refuse — those are
                      * rewritten, not deleted — and the server enforces that
                      * rather than trusting this button.
                      */}
                    {!["anchor", "project"].includes(n.type) && (
                      <button
                        onClick={async () => {
                          if (!confirm(`Forget "${n.name}"? The agent will no longer recall it.`)) return;
                          try {
                            await api.forgetMemory(n.name);
                            setOpen(null);
                            setData((d) => ({
                              ...d,
                              total: Math.max(0, d.total - 1),
                              nodes: d.nodes.filter((x) => x.id !== n.id),
                            }));
                          } catch (e) {
                            alert(String(e));
                          }
                        }}
                        className="mt-2 rounded-lg border border-line px-2 py-0.5 text-[11px] text-fg-faint transition hover:border-danger/40 hover:text-danger"
                      >
                        Forget this
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
