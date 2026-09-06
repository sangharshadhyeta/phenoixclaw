/**
 * The last of the server's own output, kept in memory so it can be read.
 *
 * The portal writes real diagnostics to stdout — a quarantined database, a
 * degraded dependency, an unhandled rejection it survived — and every one of
 * them is invisible to the person using it. Reading them meant having a shell
 * on the host, which is exactly the situation the portal exists to avoid: it
 * is meant to be usable from a browser on the LAN.
 *
 * A ring buffer rather than a file, deliberately. A file needs rotation, a
 * disk budget and a cleanup pass, and this is not an audit trail — the audit
 * table is that, and it is already persistent. This is "what has the server
 * said recently", which is worth exactly as much as it is easy.
 *
 * Wrapping `console` rather than asking callers to use a logger: there are
 * about forty existing call sites and the value is in capturing the ones
 * nobody thought to route anywhere.
 */

export interface LogLine {
  at: string;
  level: "info" | "error";
  text: string;
}

const MAX_LINES = 500;
const lines: LogLine[] = [];

/** Truncated per line: one stack trace should not evict the whole buffer. */
const MAX_LINE = 2000;

function push(level: LogLine["level"], args: unknown[]): void {
  const text = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a)))
    .join(" ")
    .slice(0, MAX_LINE);
  if (!text.trim()) return;
  lines.push({ at: new Date().toISOString(), level, text });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let installed = false;

/**
 * Start capturing. Idempotent, and it still writes through.
 *
 * The console output is what a person watching `docker logs` relies on, and
 * swallowing it to build a nicer view in the browser would be a poor trade.
 */
export function captureLogs(): void {
  if (installed) return;
  installed = true;
  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    push("info", args);
    realLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("error", args);
    realWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", args);
    realError(...args);
  };
}

/** The most recent lines, oldest first. */
export function recentLogs(limit = 200): LogLine[] {
  return lines.slice(-Math.max(1, Math.min(limit, MAX_LINES)));
}
