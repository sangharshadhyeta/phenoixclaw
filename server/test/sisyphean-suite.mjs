/**
 * The Sisyphean regimen, run against Phoenix.
 *
 * Ported from Sisyphean's `tests/test_suite.py` (T1-T11, L2-L6) — the same
 * requests, and the same thing it was checking: **the answer and the path
 * taken to it**. Its own summary of why the path matters is worth keeping:
 *
 *     Direct queries (hi, ok, thanks) must NOT call any outer tool
 *     Math queries (2+2) must call Bash — not answered from LLM memory
 *     Research queries (capital of France) must call WebSearch
 *     File/folder tasks must call Bash with the right command
 *
 * Phoenix's architecture moves where the path runs, not whether it is
 * required: the conversation has no shell and no search, so "must call Bash"
 * becomes "must reach a session that has one". A greeting must still touch
 * nothing, and an answer must still not be produced from the model's own head.
 *
 * This talks to a running portal over its own API. It is not part of `npm
 * test` — it needs the server, a model and a search engine up, and it takes
 * minutes rather than milliseconds.
 *
 *     node server/test/sisyphean-suite.mjs [http://127.0.0.1:8101]
 */
const args = process.argv.slice(2);
const BASE = args.find((a) => /^https?:\/\//.test(a)) || process.env.PORTAL_URL || "http://127.0.0.1:8101";
const PASSWORD = process.env.PORTAL_PASSWORD || "";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 300000);

let cookie = "";
let pass = 0, fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`      PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`      FAIL  ${label}${detail ? `  — ${detail}` : ""}`); }
}
const clip = (s, n = 90) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${clip(text, 160)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * What one turn did.
 *
 * `tools` are the conversation's own calls. `sessions` are the pieces of work
 * it handed out — in Phoenix that *is* the path for anything needing a shell
 * or the web, so a check that used to read "called Bash" reads "started a
 * session, and the session ran bash".
 */
class Turn {
  constructor() { this.tools = []; this.sessions = []; this.reply = ""; this.childTools = []; this.childBash = []; }
  called(...names) { return names.some((n) => this.tools.includes(n)); }
  handedOut() { return this.sessions.length > 0; }
  /** Nothing at all happened outside the conversation — the "direct" path. */
  direct() { return this.tools.length === 0 && this.sessions.length === 0; }
  childRan(...names) { return names.some((n) => this.childTools.includes(n)); }
  bashContains(...needles) {
    const all = this.childBash.join(" ").toLowerCase();
    return needles.some((n) => all.includes(n.toLowerCase()));
  }
}

/**
 * The replay, read to the point where the server says it is caught up.
 *
 * `/events` is an SSE stream that stays open and tails — so `await
 * res.text()` never resolves, the abort threw, and every read returned
 * nothing. Every case then failed with an empty answer while the portal was
 * behaving correctly. The server emits `event: caught-up` when the replay is
 * done; that is the marker to stop on.
 */
async function eventsOf(sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const out = [];
  try {
    const res = await fetch(`${BASE}/api/sessions/${sessionId}/events?since=0`, {
      headers: { cookie }, signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      let caughtUp = false;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (/^event:\s*caught-up/m.test(frame)) { caughtUp = true; continue; }
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { out.push(JSON.parse(line.slice(6))); } catch { /* partial frame */ }
      }
      if (caughtUp) { controller.abort(); break; }
    }
  } catch {
    // An abort is how this ends; whatever was read before it still counts.
  } finally { clearTimeout(timer); }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusOf(id) {
  try { return (await api(`/api/sessions/${id}`)).status; } catch { return "gone"; }
}

/**
 * Send one message and wait for everything it set in motion to settle.
 *
 * Not just the conversation's own turn: a handed-out session is the path, so
 * the turn is not over until that session has finished and its answer has come
 * back. That wait is the point of the whole arrangement being tested.
 */
async function ask(chatId, message) {
  /**
   * Bounded by sequence, not by how many events came back last time.
   *
   * The replay is read with a timeout and can be cut short, so two reads of
   * the same history do not always return the same number of frames — slicing
   * by count then dropped the turn's own reply and every case failed with an
   * empty answer.
   */
  const seqs = (await eventsOf(chatId)).map((e) => Number(e.seq) || 0);
  const before = seqs.length ? Math.max(...seqs) : 0;
  await api(`/api/sessions/${chatId}/prompt`, { method: "POST", body: JSON.stringify({ message }) });

  const turn = new Turn();
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let settledAt = 0;

  while (Date.now() < deadline) {
    await sleep(2500);
    const events = (await eventsOf(chatId)).filter((e) => (Number(e.seq) || 0) > before);

    turn.tools = [];
    turn.sessions = [];
    let reply = "";
    let sawResult = false;
    for (const ev of events) {
      const p = ev?.payload ?? {};
      if (ev.type === "tool_execution_start" && p.toolName) turn.tools.push(p.toolName);
      if (ev.type === "portal_task_started" && p.sessionId) turn.sessions.push(p.sessionId);
      if (ev.type === "mirrored" && p.type === "portal_task_result") sawResult = true;
      if (ev.type === "message_end" && p.message?.role === "assistant") {
        const text = (p.message.content ?? [])
          .filter((c) => c?.type === "text").map((c) => c.text).join("");
        if (text.trim()) reply = text;
      }
    }
    turn.reply = reply;

    const chatIdle = (await statusOf(chatId)) !== "running";
    const kidsIdle = (await Promise.all(turn.sessions.map(statusOf)))
      .every((s) => s !== "running");
    // A handed-out turn is finished when its answer has come back, not when
    // the chat first stops talking — the chat says "I've started a session"
    // and goes idle long before the work is done.
    const done = chatIdle && kidsIdle && (!turn.sessions.length || sawResult);
    if (done) {
      // One more pass, so the delivered answer is the reply we assert on.
      if (!settledAt) { settledAt = Date.now(); continue; }
      if (Date.now() - settledAt > 3000) break;
    } else settledAt = 0;
  }

  for (const child of turn.sessions) {
    for (const ev of await eventsOf(child)) {
      const p = ev?.payload ?? {};
      if (ev.type === "tool_execution_start" && p.toolName) {
        turn.childTools.push(p.toolName);
        const cmd = p.args?.command ?? p.args?.cmd ?? "";
        if (cmd) turn.childBash.push(String(cmd));
      }
    }
  }
  return turn;
}

// ── the regimen ──────────────────────────────────────────────────────────────

const REGIMEN = [
  {
    id: "T1", prompt: "hi",
    check: (t) => {
      ok("T1 answer is a greeting",
         /\b(hi|hello|hey|how can|ready)\b/i.test(t.reply), clip(t.reply));
      ok("T1 path: nothing outside the conversation", t.direct(),
         `tools=${t.tools} sessions=${t.sessions.length}`);
    },
  },
  {
    id: "T2", prompt: "2+2",
    check: (t) => {
      ok("T2 answer contains 4", /\b4\b/.test(t.reply), clip(t.reply));
      ok("T2 path: not answered from the model's head", t.handedOut(),
         `tools=${t.tools} sessions=${t.sessions.length}`);
      ok("T2 path: a session ran it", t.childRan("bash") || t.bashContains("2+2", "python", "expr"),
         `child=${t.childTools}`);
    },
  },
  {
    id: "T3", prompt: "what is 12 times 7?",
    check: (t) => {
      ok("T3 answer contains 84", /\b84\b/.test(t.reply), clip(t.reply));
      ok("T3 path: a session was given the sum", t.handedOut(), `tools=${t.tools}`);
    },
  },
  {
    id: "T4", prompt: "100/4",
    check: (t) => {
      ok("T4 answer contains 25", /\b25\b/.test(t.reply), clip(t.reply));
    },
  },
  {
    id: "T5", prompt: "what is the square root of 144?",
    check: (t) => {
      ok("T5 answer contains 12", /\b12\b/.test(t.reply), clip(t.reply));
      ok("T5 path: computed, not recalled", t.handedOut(), `tools=${t.tools}`);
    },
  },
  {
    id: "T6", prompt: "what is the capital of France?",
    check: (t) => {
      ok("T6 answer contains Paris", /paris/i.test(t.reply), clip(t.reply));
      ok("T6 path: consulted a source", t.handedOut() || t.called("graph_recall"),
         `tools=${t.tools}`);
      ok("T6 path: the session searched", t.childRan("web_search", "web_fetch") || !t.handedOut(),
         `child=${t.childTools}`);
    },
  },
  {
    id: "T7", prompt: "what is the latest Python version?",
    check: (t) => {
      ok("T7 answer has a version number", /3\.\d+/.test(t.reply), clip(t.reply));
      ok("T7 path: live info was looked up, not remembered", t.handedOut(), `tools=${t.tools}`);
      ok("T7 path: the session searched the web", t.childRan("web_search", "web_fetch"),
         `child=${t.childTools}`);
    },
  },
  {
    id: "T8", prompt: "create a folder called test123",
    check: (t) => {
      ok("T8 answer confirms creation",
         /(test123|creat|folder|mkdir|done|made)/i.test(t.reply), clip(t.reply));
      ok("T8 path: a session did the file-system work", t.handedOut(), `tools=${t.tools}`);
      ok("T8 path: mkdir or test123 in what it ran",
         t.bashContains("mkdir", "test123"), `cmds=${clip(t.childBash.join(" | "), 120)}`);
    },
  },
  {
    id: "T9", prompt: "remember I prefer vim",
    check: (t) => {
      ok("T9 answer acknowledges vim", /vim/i.test(t.reply), clip(t.reply));
      ok("T9 path: no session — remembering is the conversation's own job",
         !t.handedOut(), `sessions=${t.sessions.length}`);
    },
  },
  {
    id: "T10", prompt: "ok",
    check: (t) => {
      ok("T10 answer is non-empty", Boolean(t.reply.trim()));
      ok("T10 no hollow filler", !/certainly!/i.test(t.reply), clip(t.reply));
      ok("T10 path: nothing outside the conversation", t.direct(),
         `tools=${t.tools} sessions=${t.sessions.length}`);
    },
  },
  {
    id: "T11", prompt: "thanks",
    check: (t) => {
      ok("T11 answer is non-empty", Boolean(t.reply.trim()));
      ok("T11 not filed as a memory",
         !/(saved|noted that|i'll remember|storing)/i.test(t.reply), clip(t.reply));
      ok("T11 path: nothing outside the conversation", t.direct(),
         `tools=${t.tools} sessions=${t.sessions.length}`);
    },
  },
  // ── L2-L6, the API group's behavioural half ────────────────────────────────
  {
    id: "L2", prompt: "thanks, that helps",
    check: (t) => {
      ok("L2 sensible reply",
         /(welcome|glad|anytime|no problem|happy|sure)/i.test(t.reply), clip(t.reply));
      ok("L2 path: direct", t.direct(), `tools=${t.tools} sessions=${t.sessions.length}`);
    },
  },
  {
    id: "L3", prompt: "Run 'ls -1' and tell me what files you see.",
    check: (t) => {
      ok("L3 answer says something about files", t.reply.trim().length > 10, clip(t.reply));
      ok("L3 path: a session ran it", t.handedOut(), `tools=${t.tools}`);
      ok("L3 path: ls in what it ran", t.bashContains("ls"), `cmds=${clip(t.childBash.join(" | "), 120)}`);
    },
  },
  {
    id: "L4",
    prompt: "Write a Python script counter.py that prints the sum of integers 1 to 10. Run it and tell me what number it printed.",
    check: (t) => {
      ok("L4 answer contains 55", /\b55\b/.test(t.reply), clip(t.reply));
      ok("L4 path: handed to a session", t.handedOut(), `tools=${t.tools}`);
      ok("L4 path: python or counter in what it ran",
         t.bashContains("python", "counter"), `cmds=${clip(t.childBash.join(" | "), 120)}`);
    },
  },
  {
    id: "L5",
    prompt:
      "Write calc3.py with add(a,b) and multiply(a,b). Then write test_calc3.py that asserts " +
      "add(2,3)==5 and multiply(3,4)==12 and prints 'ALL TESTS PASSED'. Run it and report.",
    check: (t) => {
      ok("L5 answer mentions the tests passing",
         /(passed|pass|all tests)/i.test(t.reply), clip(t.reply));
      ok("L5 path: handed to a session", t.handedOut(), `tools=${t.tools}`);
      ok("L5 path: it wrote and then ran",
         t.bashContains("python", "test_calc3"), `cmds=${clip(t.childBash.join(" | "), 120)}`);
    },
  },
  {
    id: "L6",
    prompt:
      "Search for Python hashlib.md5 usage, then write hasher.py that hashes the string 'hello' " +
      "with md5 and prints the hex digest. Run it and tell me the output.",
    check: (t) => {
      ok("L6 answer has the hash or names it",
         /(5d41|md5|hash|hex|hasher)/i.test(t.reply), clip(t.reply));
      ok("L6 path: handed to a session", t.handedOut(), `tools=${t.tools}`);
      ok("L6 path: it searched before writing",
         t.childRan("web_search", "web_fetch"), `child=${t.childTools}`);
      ok("L6 path: and ran the file", t.bashContains("python", "hasher"),
         `cmds=${clip(t.childBash.join(" | "), 120)}`);
      const searchAt = t.childTools.findIndex((n) => /web_/.test(n));
      const bashAt = t.childTools.findIndex((n) => n === "bash");
      ok("L6 path: search BEFORE running", searchAt === -1 || bashAt === -1 || searchAt < bashAt,
         `order=${t.childTools}`);
    },
  },
];

// ── run ──────────────────────────────────────────────────────────────────────

const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);

console.log(`\n  Sisyphean regimen against ${BASE}`);
if (!PASSWORD) {
  console.log("  PORTAL_PASSWORD is not set — the portal will refuse every request.");
  process.exit(2);
}
await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
const chat = await api("/api/agent/main");
console.log(`  conversation ${chat.id}\n`);

for (const test of REGIMEN) {
  if (only && !only.split(",").includes(test.id)) continue;
  console.log(`  [${test.id}] ${clip(test.prompt, 100)}`);
  const started = Date.now();
  let turn;
  try {
    turn = await ask(chat.id, test.prompt);
  } catch (e) {
    fail++; failures.push(`${test.id} threw`);
    console.log(`      FAIL  ${test.id} threw — ${clip(e.message, 120)}`);
    continue;
  }
  console.log(`      reply : ${clip(turn.reply, 110)}`);
  console.log(`      chat  : ${turn.tools.join(", ") || "(no tools)"}`);
  console.log(`      work  : ${turn.sessions.length ? turn.sessions.join(", ") : "(no session)"}` +
              `${turn.childTools.length ? ` → ${turn.childTools.join(", ")}` : ""}`);
  console.log(`      took  : ${Math.round((Date.now() - started) / 1000)}s`);
  test.check(turn);
  console.log("");
}

console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`  failed: ${failures.join(" | ")}`);
process.exit(fail ? 1 : 0);
