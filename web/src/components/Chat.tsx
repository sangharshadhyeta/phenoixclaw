import { LuPanelLeftClose, LuPanelLeftOpen } from "react-icons/lu";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api, type PiCommand, type PortalEvent, type Session } from "../api";
import { buildTranscript, type Item } from "../transcript";
import { ComposerBar } from "./ComposerBar";
import { TaskPanel } from "./TaskPanel";

/**
 * Context the portal attaches to a message, and what to call it.
 *
 * The agent needs to be told who is speaking and what it said while nobody was
 * talking to it. A person reading the transcript does not — they wrote the
 * message, so seeing their own words buried under three framing blocks is
 * noise. Folded away rather than dropped: it is still what the model saw, and
 * when a reply looks strange this is usually why.
 */
/** Keep in step with what the server attaches — see channels/supervisor.ts. */
const CONTEXT_BLOCKS: { tag: string; label: string }[] = [
  { tag: "speaker", label: "Speaker" },
  { tag: "sent-since-you-last-spoke", label: "Sent while idle" },
  { tag: "answer-from-primary", label: "Answer" },
  { tag: "channel-instructions", label: "Channel instructions" },
  { tag: "routine", label: "Routine" },
];

function splitContext(raw: string): { text: string; blocks: { label: string; body: string }[] } {
  let text = raw;
  const blocks: { label: string; body: string }[] = [];
  for (const { tag, label } of CONTEXT_BLOCKS) {
    // The opening tag may carry attributes, as <routine name="..."> does.
    const re = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g");
    text = text.replace(re, (match) => {
      const body = match
        .replace(new RegExp(`^<${tag}(\\s[^>]*)?>`), "")
        .replace(new RegExp(`</${tag}>$`), "")
        .trim();
      if (body) blocks.push({ label, body });
      return "";
    });
  }
  return { text: text.trim(), blocks };
}

function ContextChip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-2 py-0.5 text-[11px] transition ${
          open
            ? "bg-accent/20 text-accent"
            : "bg-fg/5 text-fg-faint hover:bg-fg/10 hover:text-fg-muted"
        }`}
        title="Context the portal attached to this message"
      >
        {label}
      </button>
      {open && (
        <pre className="mt-1 w-full whitespace-pre-wrap rounded-lg bg-fg/5 p-2 text-left text-[11px] leading-relaxed text-fg-muted">
          {body}
        </pre>
      )}
    </>
  );
}

/**
 * A run of work from one other session, collapsed to a single line.
 *
 * Open by default when it is short and shut when it is long: a two-line thread
 * costs nothing to show, and a forty-line one is what buries the conversation.
 * The summary line always says what the session was asked to do when that is
 * known, because it is the one line that explains the rest.
 */
/**
 * A tool call, with what it found.
 *
 * The transcript used to show which tools were reached for and nothing about
 * what any of them returned, so reading back a run you had not watched meant
 * opening the database. This is BirdClaw's `cards.py` in miniature: the call on
 * one line, the result behind a click.
 *
 * Shut by default. A finished run has dozens of these and most are `read` doing
 * what `read` does; the one that matters is the one you go looking for, and it
 * is one click away. An error opens itself, because that one you were not
 * looking for.
 */
/** Compact enough to sit in a header: 3.8k rather than 3799. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * How long the current run has been going.
 *
 * "working…" says the agent is alive and nothing about whether it has been
 * alive for four seconds or forty minutes — which is the difference between
 * waiting and intervening.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = now - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  return (
    <span className="font-mono text-[11px] text-fg-faint">
      {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}
    </span>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(item.status === "error");
  const tone =
    item.status === "error"
      ? "text-danger"
      : item.status === "running"
        ? "text-accent"
        : "text-fg-faint";

  // A diff reads as a diff and a listing reads as a listing. Nothing clever —
  // just enough that the shape of the output is recognisable at a glance.
  const monospace = item.name !== "web_search";

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => item.result && setOpen((v) => !v)}
        disabled={!item.result}
        className={`flex w-full items-center gap-2 text-left font-mono text-[11px] text-fg-faint ${
          item.result ? "hover:text-fg-muted" : "cursor-default"
        }`}
      >
        <span className={`shrink-0 ${tone}`}>
          {item.status === "running" ? "◇" : item.status === "error" ? "✕" : "◆"}
        </span>
        <span className="shrink-0 text-fg-subtle">{item.name}</span>
        {item.detail && <span className="min-w-0 truncate opacity-60">{item.detail}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 opacity-50">
          {item.ms !== undefined && <span>{formatMs(item.ms)}</span>}
          {item.result && <span>{open ? "▾" : "▸"}</span>}
        </span>
      </button>
      {open && item.result && (
        <pre
          className={`mt-1 max-h-80 overflow-auto rounded border border-line bg-raised/40 px-2 py-1.5 text-[11px] leading-relaxed text-fg-muted ${
            monospace ? "font-mono" : ""
          } whitespace-pre-wrap`}
        >
          {item.result}
        </pre>
      )}
    </div>
  );
}

/** Sub-second in milliseconds, then seconds — a run's shape, not a benchmark. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * The most useful line in a folded run.
 *
 * Prefer what it *said* — that is a conclusion. Failing that, the last tool it
 * reached for, which at least says what kind of work it was.
 */
function summarise(lines: Array<{ mode?: string; text: string }>): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].mode === "said" && lines[i].text.trim()) return lines[i].text.trim();
  }
  const last = lines[lines.length - 1];
  return last?.text?.trim() ?? "";
}

function Thread({ item }: { item: Extract<Item, { kind: "thread" }> }) {
  const asked = item.items.find((i) => i.mode === "asked");
  const long = item.items.length > 4;
  const [open, setOpen] = useState(!long);

  return (
    <div className="border-l-2 border-line pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 py-0.5 text-left text-[11px] text-fg-subtle hover:text-fg-muted"
      >
        <span className="shrink-0 font-medium">
          {open ? "▾" : "▸"} {item.source}
        </span>
        {/*
          * What it is doing, not how many things it did.
          *
          * A collapsed run showed "4 steps", which is the one fact about it
          * that nobody needs — the count is already on the right. What a
          * reader wants from a folded line is whether to unfold it, and that
          * takes a subject: the last thing said, or the last tool used.
          */}
        <span className="min-w-0 truncate text-fg-faint">
          {asked?.text || summarise(item.items) || `${item.items.length} steps`}
        </span>
        {!open && (
          <span className="ml-auto shrink-0 text-fg-faint">{item.items.length}</span>
        )}
      </button>
      {open && (
        <div className="pb-0.5">
          {item.items.map((line) => {
            const prose = line.mode === "asked" || line.mode === "said";
            return (
              <div key={line.id} className="flex gap-2 py-0.5 text-[11px] text-fg-faint">
                <span className="shrink-0 text-fg-subtle">
                  {line.phase === "start"
                    ? "▸"
                    : line.phase === "end"
                      ? "■"
                      : line.mode === "asked"
                        ? "▹"
                        : line.mode === "said"
                          ? "◂"
                          : "·"}
                </span>
                <span className={prose ? "min-w-0 whitespace-pre-wrap" : "min-w-0 truncate"}>
                  {line.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Chat({
  session,
  sidebarCollapsed = false,
  onToggleSidebar,
  events,
  onSend,
  onAbort,
  onClientCommand,
  connected = true,
}: {
  session: Session;
  /** Whether the sidebar is hidden, and how to put it back. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  events: PortalEvent[];
  /** False while the event stream is reconnecting — see the header strip. */
  connected?: boolean;
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Builtins the portal itself services — /settings, /new, /name. */
  onClientCommand: (name: string, args: string) => void | Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [panelRequest, setPanelRequest] = useState<"model" | "effort" | null>(null);
  /**
   * Find something in this conversation.
   *
   * A long run is thousands of lines and the browser's own find only sees what
   * is rendered — which, with tool results collapsed and threads folded, is a
   * fraction of it. This searches the transcript itself and shows what matched,
   * including inside results that are currently shut.
   */
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const allItems = useMemo(() => buildTranscript(events), [events]);
  /**
   * Per session and not remembered.
   *
   * The raw view is for a moment of confusion, not a way of working — leaving
   * it on would replace a readable conversation with a wall of JSON the next
   * time the tab opened.
   */
  const [raw, setRaw] = useState(false);
  /** The agent's own conversation — the one place instructions are accepted. */
  const conversational = session.kind === "agent";

  /** Everything a line holds, so a match inside a collapsed result still counts. */
  const haystack = (item: Item): string => {
    switch (item.kind) {
      case "thread":
        return item.items.map((i) => `${i.source} ${i.text}`).join(" ");
      case "tool":
        return `${item.name} ${item.detail ?? ""} ${item.result ?? ""}`;
      case "assistant":
        return `${item.text} ${item.thinking}`;
      default:
        return (item as { text?: string }).text ?? "";
    }
  };

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((item) => haystack(item).toLowerCase().includes(q));
  }, [allItems, search]);
  /**
   * Whether it is working, from the event stream rather than the session row.
   *
   * The row is only refreshed for sessions in the sidebar list, and that list
   * is task sessions — so the agent's own conversation carried whatever status
   * it had when the page loaded, forever. "working…" never appeared in Chat,
   * which is the one place it matters most: it is the session you are sitting
   * in front of waiting for.
   *
   * `portal_status` is emitted on every transition and arrives over the same
   * SSE connection as everything else here, so this is live by construction
   * and needs no polling.
   */
  const running = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "portal_status") continue;
      const status = (e.payload as { status?: string } | undefined)?.status;
      if (typeof status === "string") return status === "running";
    }
    return session.status === "running";
  }, [events, session.status]);

  /**
   * When this run began, for the elapsed clock in the header.
   *
   * Taken from the events rather than the wall clock at mount, so a page opened
   * mid-run still shows how long the agent has been at it rather than starting
   * from zero.
   */
  const runStartedAt = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "portal_prompt" && ev.at) return ev.at;
    }
    return undefined;
  }, [events]);

  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  useEffect(() => {
    api
      .commands(session.id)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
    // Refetch when a run ends: installing an extension mid-session should make
    // its commands show up without a reload.
  }, [session.id, running]);

  // Show the palette while the composer holds a bare "/name" prefix.
  const slashQuery = /^\/([\w:-]*)$/.exec(input.trimStart());
  const matches = slashQuery
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery[1].toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length, events.length]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    // Some builtins are UI, not prompts: /model opens the picker the pill uses,
    // /settings opens the modal. Sending them to pi would just be a chat line.
    const parsed = /^\/([\w-]+)\s*(.*)$/.exec(msg);
    const client = parsed
      ? commands.find((c) => c.name === parsed[1] && c.where === "client")
      : undefined;
    if (client && parsed) {
      setInput("");
      if (client.name === "model") setPanelRequest("model");
      else await onClientCommand(client.name, parsed[2]);
      return;
    }

    setSending(true);
    setInput("");
    try {
      await onSend(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        {/*
          * Hide the sidebar, from the header.
          *
          * Only while it is showing. The way *back* is App's own toggle, which
          * is on screen for every view — this one is in a chat header, and a
          * collapsed sidebar on the Memory or Routines page would otherwise
          * have nothing to click.
          */}
        {onToggleSidebar && !sidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="-ml-1 shrink-0 rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/5 hover:text-fg"
            title={sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"}
            aria-label={sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"}
          >
            {sidebarCollapsed ? <LuPanelLeftOpen className="h-4 w-4" /> : <LuPanelLeftClose className="h-4 w-4" />}
          </button>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{session.title}</h2>
          {/*
            * What this session is and what it has cost, always visible.
            *
            * The model and the running total were reachable — in a settings
            * panel, or by asking — and so in practice went unread. An agent
            * left to work unattended is exactly the case where "which model is
            * this, and how much has it spent" wants answering at a glance
            * rather than on request.
            */}
          <p className="flex items-center gap-2 truncate font-mono text-[11px] text-fg-faint">
            <span className="truncate">{session.workspace}</span>
            {session.model && (
              <>
                <span className="opacity-40">·</span>
                <span className="truncate">{session.model.split("/").pop()}</span>
              </>
            )}
            {session.usage && session.usage.tokensIn > 0 && (
              <>
                <span className="opacity-40">·</span>
                <span title="tokens in / out for this session, across every conversation it has had">
                  {formatTokens(session.usage.tokensIn)}↑ {formatTokens(session.usage.tokensOut)}↓
                </span>
                {session.usage.cost > 0 && <span>${session.usage.cost.toFixed(3)}</span>}
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/*
            * Reconnecting looks exactly like quiet otherwise: the transcript
            * simply stops, with nothing to say whether the agent finished or
            * the connection dropped. Only shown when something is wrong —
            * a green light nobody needs is a light nobody reads.
            */}
          {!connected && (
            <span
              className="flex items-center gap-1.5 rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn"
              title="The event stream dropped and is retrying. Nothing is lost — it resumes from where it left off."
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
              reconnecting
            </span>
          )}
          {searching ? (
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  setSearching(false);
                }
              }}
              placeholder="find in this conversation…"
              className="w-56 rounded-lg border border-line bg-transparent px-2 py-1 text-xs text-fg outline-none placeholder:text-fg-faint"
            />
          ) : (
            <button
              onClick={() => setSearching(true)}
              title="Find in this conversation"
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg"
            >
              Find
            </button>
          )}
          {search.trim() && (
            <span className="font-mono text-[11px] text-fg-faint">
              {items.length} of {allItems.length}
            </span>
          )}
          {running && runStartedAt && <Elapsed since={runStartedAt} />}
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              interrupted — send a message to resume
            </span>
          )}
          {running && (
            <button
              onClick={onAbort}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg"
            >
              Stop
            </button>
          )}
          <button
            onClick={() => setRaw((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 text-xs transition hover:bg-fg/5 ${
              raw ? "border-accent text-accent" : "border-line text-fg-muted hover:text-fg"
            }`}
            title="Show the events behind the transcript"
          >
            {raw ? "Transcript" : "Events"}
          </button>
        </div>
        </div>
      </header>

      {/* Under the header rather than in the transcript: the plan is state, not
          something that was said, and threading it into the conversation would
          make it scroll away exactly when it is worth seeing. */}
      <TaskPanel sessionId={session.id} running={running} />

      {/*
        * The events behind the transcript.
        *
        * The rendered conversation is an interpretation — tool calls grouped,
        * results paired with their calls, framing hidden. That is right almost
        * always and wrong exactly when something is behaving oddly, which is
        * when the question becomes "what did the portal actually record?"
        * Until now the only answer was curl against the SSE endpoint.
        */}
      {raw ? (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-5xl space-y-1 font-mono text-[11px] leading-snug">
            {events.length === 0 && <div className="text-fg-subtle">No events recorded yet.</div>}
            {events.map((ev) => (
              <details key={ev.seq} className="rounded border border-line bg-surface/40 px-2 py-1">
                <summary className="cursor-pointer truncate text-fg-muted">
                  <span className="text-fg-subtle">{String(ev.seq).padStart(6, " ")} </span>
                  <span className="text-accent">{ev.type}</span>
                  <span className="text-fg-subtle"> {ev.at ?? ""}</span>
                </summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-fg-muted">
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-3">
        {items.length === 0 && (
          <div className="pt-16 text-center">
            <p className="text-sm text-fg-muted">
              {conversational ? "Ask for something." : "This work has not started yet."}
            </p>
            <p className="mt-1 text-xs text-fg-faint">
              {conversational
                ? "Anything that is work gets a session of its own. Close the tab — it keeps going."
                : "It runs on its own; the answer comes back in Chat."}
            </p>
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            const { text, blocks } = splitContext(item.text);
            // Nothing but framing: the portal spoke, not a person. Drawing it as
            // a message bubble with no message in it reads as something broken.
            if (!text) {
              return (
                <div key={item.id} className="flex flex-wrap justify-end gap-1">
                  {blocks.map((b, i) => (
                    <ContextChip key={i} label={b.label} body={b.body} />
                  ))}
                </div>
              );
            }
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
                  <div className="whitespace-pre-wrap">{text}</div>
                  {blocks.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                      {blocks.map((b, i) => (
                        <ContextChip key={i} label={b.label} body={b.body} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="max-w-[90%]">
                {item.thinking && (
                  <details className="mb-1 text-xs text-fg-subtle">
                    <summary className="cursor-pointer hover:text-fg-muted">thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-line pl-2">
                      {item.thinking}
                    </div>
                  </details>
                )}
                {item.text && (
                  <div className="md text-sm leading-relaxed text-fg">
                    {/* A reasoning model sometimes closes a thought inside the
                        answer; the stray tag is noise to whoever is reading. */}
                    <ReactMarkdown>{item.text.replace(/<\/?think(ing)?>/gi, "")}</ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "tool") return <ToolCard key={item.id} item={item} />;
          if (item.kind === "self") {
            /**
             * Work from elsewhere — a routine on its own initiative, or a task
             * session you started in another tab. Set to one side and dimmed:
             * it is here so nothing the agent does is hidden, not because it
             * was said to you, and a reader should never have to work out
             * which of the two they are looking at. Type into the box and it
             * stops and answers you.
             *
             * A request and a reply are shown in full and wrapped; a tool call
             * stays on one truncated line. The asymmetry is the point — what a
             * session was asked to do explains everything under it, where the
             * twentieth `read` does not.
             */
            const prose = item.mode === "asked" || item.mode === "said";
            return (
              <div
                key={item.id}
                className="flex gap-2 border-l-2 border-line py-0.5 pl-3 text-[11px] text-fg-faint"
              >
                <span className="shrink-0 font-medium text-fg-subtle">
                  {item.phase === "start"
                    ? "▸"
                    : item.phase === "end"
                      ? "■"
                      : item.mode === "asked"
                        ? "▹"
                        : item.mode === "said"
                          ? "◂"
                          : "·"}{" "}
                  {item.source}
                </span>
                {item.text && (
                  <span className={prose ? "min-w-0 whitespace-pre-wrap" : "min-w-0 truncate"}>
                    {item.text}
                  </span>
                )}
              </div>
            );
          }
          if (item.kind === "thread") return <Thread key={item.id} item={item} />;
          return (
            <div
              key={item.id}
              className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
                item.tone === "error"
                  ? "bg-danger/10 text-danger"
                  : "bg-raised/60 text-fg-muted"
              }`}
            >
              {item.text}
            </div>
          );
        })}

          {running && (
            <div className="flex items-center gap-1.5 py-1 text-xs text-fg-subtle">
              <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      )}

      {/*
        * Only the conversation takes instructions.
        *
        * A task session is a view of work the agent is doing — it has a plan,
        * a workspace and a brief it was given, and typing into it was a second
        * way to start work that bypassed the agent's own judgement about
        * whether something is a task at all. Ask in the chat; it decides, and
        * hands the work out with a plan.
        */}
      {conversational ? (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-line px-4 py-3"
      >
        <div className="relative mx-auto w-full max-w-3xl">
        {matches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(`/${c.name} `);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <span className="font-mono text-xs text-accent">/{c.name}</span>
                <span className="truncate text-xs text-fg-subtle">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={running ? "pi is working — send to queue a follow-up…" : "Describe the task…"}
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
          <ComposerBar
            sessionId={session.id}
            session={session}
            running={running}
            panelRequest={panelRequest}
            onPanelConsumed={() => setPanelRequest(null)}
          />
        </div>
      </form>
      ) : (
        <div className="border-t border-line px-4 py-3 text-center text-xs text-fg-subtle">
          This is work the agent is doing. Ask in <strong className="text-fg-muted">Chat</strong>{" "}
          to start something or change it.
        </div>
      )}
    </div>
  );
}
