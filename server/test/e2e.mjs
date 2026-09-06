/**
 * End to end, against a running portal.
 *
 * The contracts test tools in isolation, and that is exactly how the worst bug
 * of the day got through: every writing-tool assertion passed while a live
 * session planned five sections and wrote nothing. The cause was not in any of
 * them — pi's learned step budget had collapsed to three assistant turns, so
 * the session was cut off mid-plan. No unit test can see that, because the
 * thing that broke is the loop around the tools.
 *
 * So this asks the portal for work and looks at what is on disk afterwards.
 * It is slow, it needs a model, and it is not part of `npm test` for that
 * reason.
 *
 *     PORTAL_PASSWORD=... node server/test/e2e.mjs [http://127.0.0.1:8101]
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASE = process.argv[2] || process.env.PORTAL_URL || "http://127.0.0.1:8101";
const PASSWORD = process.env.PORTAL_PASSWORD || "phoenixclaw";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 480_000);

let pass = 0, fail = 0;
const ok = (n, c, detail) => {
  c ? (pass++, console.log("  PASS  " + n))
    : (fail++, console.log("  FAIL  " + n + (detail ? `\n          ${detail}` : "")));
};

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });

/** Ask for something, wait for the run to settle, and report what the session did. */
async function run(title, message) {
  const { body: session } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title }) });
  if (!session?.id) throw new Error(`could not create a session: ${JSON.stringify(session)}`);
  await api(`/api/sessions/${session.id}/prompt`, { method: "POST", body: JSON.stringify({ message }) });

  const deadline = Date.now() + TIMEOUT_MS;
  let status = "running";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const { body } = await api(`/api/sessions/${session.id}`);
    status = body?.status ?? "unknown";
    if (status !== "running") break;
  }

  // The event log is the record of what happened; ?since=0 replays it.
  const res = await fetch(`${BASE}/api/sessions/${session.id}/events?since=0`, { headers: { cookie } });
  const reader = res.body.getReader();
  const chunks = [];
  const stop = Date.now() + 15_000;
  while (Date.now() < stop) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true }), 4000)),
    ]);
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  reader.cancel().catch(() => {});
  const tools = [];
  let assistantTurns = 0;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
    if (e.type === "tool_execution_start") tools.push(e.payload?.toolName);
    if (e.type === "message_end" && e.payload?.message?.role === "assistant") assistantTurns++;
  }
  return { id: session.id, status, tools, assistantTurns, workspace: `/workspaces/session-${session.id}` };
}

// --- a module written a section at a time ----------------------------------
// The outcome, not the wiring: a file that exists, parses, and has the
// functions that were asked for. Planning and then writing nothing passed
// every unit test there was.
{
  console.log("\n  writing a module incrementally");
  const r = await run("e2e-code", "Write stats.mjs — a module exporting mean, median, stddev, and a summary function that uses all three. Each properly documented.");
  const file = `${r.workspace}/stats.mjs`;
  console.log(`      ${r.status}, ${r.assistantTurns} assistant turns, tools: ${r.tools.join(" → ") || "none"}`);

  ok("the run settles rather than hanging", r.status !== "running", `status was ${r.status}`);
  ok("it plans before writing", r.tools.includes("write_plan"));
  ok("and then actually writes", r.tools.includes("write_next"), `tools: ${r.tools.join(", ")}`);
  ok("the file exists", existsSync(file), file);

  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  ok("the file is not empty", text.trim().length > 0, `${text.length} characters`);
  ok("it parses as JavaScript",
     text.trim() ? spawnSync(process.execPath, ["--check", file]).status === 0 : false);
  for (const fn of ["mean", "median", "stddev", "summary"]) {
    ok(`it defines ${fn}`, new RegExp(`(function|const|let)\\s+${fn}\\b|${fn}\\s*[=(]`).test(text));
  }
  // The budget that caused all of this. Three was the ceiling; anything at or
  // below it means the cap is back.
  ok("the run was not cut off after three turns", r.assistantTurns > 3, `${r.assistantTurns} turns`);
}

// --- a short thing stays short ---------------------------------------------
// The other half of the standing practice: planning a one-line file is
// ceremony, and a tool that always fires is a tool nobody can reason about.
{
  console.log("\n  a short thing is left alone");
  const r = await run("e2e-short", "Create a file called note.txt containing exactly the line: hello");
  console.log(`      ${r.status}, tools: ${r.tools.join(" → ") || "none"}`);
  ok("the run settles", r.status !== "running");
  ok("nothing is planned for one line", !r.tools.includes("write_plan"), `tools: ${r.tools.join(", ")}`);
  ok("and the file is written", existsSync(`${r.workspace}/note.txt`));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
