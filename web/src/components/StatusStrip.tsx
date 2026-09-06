import { useEffect, useState } from "react";

/**
 * What the portal knows about itself, where somebody can see it.
 *
 * `/api/health` has had all of this from the start — how many sessions exist,
 * how big the graph is, whether extraction and embeddings are reachable, what
 * the running total has cost — and nothing displayed any of it. The one place
 * it mattered was the one place it was invisible: `SEARXNG_URL unset — web
 * search unavailable` sat in the boot log for a day while sessions quietly
 * could not search.
 *
 * A strip rather than a page, because the useful property is that you are not
 * looking for it. It is only interesting when something is wrong, and then it
 * should already be on screen.
 */

interface Dependency {
  name: string;
  status: "ok" | "degraded" | "down" | "off";
  detail?: string;
}

interface Health {
  status: "ok" | "degraded" | "down";
  dependencies: Dependency[];
  usage?: { tokensIn: number; tokensOut: number; cost: number };
  uptimeSeconds?: number;
}

/** Coarse on purpose: nobody needs seconds from a number that means "a while". */
export function humanUptime(seconds: number | undefined): string {
  if (!seconds || seconds < 0) return "";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 1 ? `${minutes}m` : `${Math.floor(seconds)}s`;
}

const TONE: Record<Dependency["status"], string> = {
  ok: "text-fg-subtle",
  // `off` is a choice somebody made, not a failure — health.ts makes the same
  // distinction, and colouring it as a fault teaches people to ignore the row.
  off: "text-fg-subtle",
  degraded: "text-warning",
  down: "text-danger",
};

const DOT: Record<Health["status"], string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
};

export function StatusStrip() {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/health");
        if (res.ok && alive) setHealth((await res.json()) as Health);
      } catch {
        // A strip that cannot reach the portal says nothing rather than
        // claiming the portal is down: the failure may be this browser's.
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!health) return null;

  const find = (name: string) => health.dependencies.find((d) => d.name === name);
  const sessions = find("portal database")?.detail ?? "";
  const graph = find("knowledge graph")?.detail ?? "";
  const notWell = health.dependencies.filter((d) => d.status === "degraded" || d.status === "down");

  return (
    <div className="border-t border-border bg-surface px-3 py-1 text-[11px] text-fg-subtle">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left hover:text-fg"
        title="Portal status"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[health.status]}`} />
        <span className="truncate">
          {[sessions, graph, humanUptime(health.uptimeSeconds) && `up ${humanUptime(health.uptimeSeconds)}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {notWell.length > 0 && (
          <span className="ml-auto shrink-0 text-warning">
            {notWell.length} issue{notWell.length > 1 ? "s" : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 space-y-0.5 border-t border-border pt-1">
          {health.dependencies.map((d) => (
            <div key={d.name} className="flex gap-2">
              <span className="w-28 shrink-0 truncate">{d.name}</span>
              <span className={`truncate ${TONE[d.status]}`}>{d.detail || d.status}</span>
            </div>
          ))}
          {health.usage && (health.usage.tokensIn > 0 || health.usage.cost > 0) && (
            <div className="flex gap-2 border-t border-border pt-1">
              <span className="w-28 shrink-0">spent</span>
              <span className="truncate">
                {health.usage.tokensIn.toLocaleString()} in · {health.usage.tokensOut.toLocaleString()} out
                {health.usage.cost > 0 && ` · $${health.usage.cost.toFixed(2)}`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
