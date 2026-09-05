import { useEffect, useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { api, type Task } from "../api";

/**
 * The agent's plan for this session, as it works through it.
 *
 * Read-only on purpose. These are the agent's own steps for the work in hand,
 * written with `task_plan` and revised when what it finds changes what should
 * happen next — routines are the thing you create and schedule. Editing them
 * here would put two authors on one list and leave neither able to trust it.
 *
 * Absent rather than empty when there is no plan: most sessions never make
 * one, and a permanent "No plan" row in every conversation is a worse trade
 * than the panel appearing when it has something to say.
 */

const TONE: Record<Task["status"], { mark: string; cls: string }> = {
  done: { mark: "✓", cls: "text-ok" },
  failed: { mark: "✗", cls: "text-danger" },
  running: { mark: "▸", cls: "text-warn" },
  pending: { mark: "·", cls: "text-fg-faint" },
};

export function TaskPanel({ sessionId, running }: { sessionId: string; running: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getTasks(sessionId)
        .then((t) => !cancelled && setTasks(t))
        .catch(() => {});
    load();
    // Faster while the agent is working, since the plan is what changes then,
    // and slower when it is idle — a finished plan does not move.
    const timer = setInterval(load, running ? 2000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, running]);

  if (!tasks.length) return null;

  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="border-b border-line bg-surface/50 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-fg-muted transition hover:text-fg"
      >
        {open ? <LuChevronDown size={12} /> : <LuChevronRight size={12} />}
        <span className="font-medium">Plan</span>
        <span className="text-fg-faint">
          {done}/{tasks.length}
        </span>
        {!open && tasks.find((t) => t.status === "running") && (
          <span className="truncate text-warn">
            {tasks.find((t) => t.status === "running")!.description}
          </span>
        )}
      </button>

      {open && (
        <ol className="mt-1.5 space-y-1">
          {tasks.map((t) => {
            const tone = TONE[t.status] ?? TONE.pending;
            return (
              <li key={t.seq} className="flex gap-2 text-[11px] leading-snug">
                <span className={`shrink-0 ${tone.cls}`}>{tone.mark}</span>
                <span className="min-w-0">
                  <span className={t.status === "done" ? "text-fg-subtle line-through" : "text-fg"}>
                    {t.description}
                  </span>
                  {t.result && <span className="text-fg-faint"> — {t.result}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
