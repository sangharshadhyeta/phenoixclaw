/**
 * The two pieces of the UI that report what the portal already knew.
 *
 * Both exist because the portal's own design creates the gap. `/api/health`
 * has always carried the session count, the graph size, what is degraded and
 * what it has cost, and nothing displayed any of it — `SEARXNG_URL unset` sat
 * in the boot log for a day while sessions quietly could not search. And a run
 * belongs to the server rather than to a request, so work carries on while you
 * look at something else and finishes in silence, which makes fire-and-forget
 * feel like forgetfulness.
 *
 * The logic worth testing is the rule about *when* to say something, so that
 * is extracted and tested; the rendering is not.
 *
 *     npm run test:ui
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = (f) => path.join(here, "..", "..", "web", "src", f);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

/**
 * Loaded by transpiling the component and taking its exports.
 *
 * These are pure functions with no imports of their own, so TypeScript's own
 * transpiler is enough — no bundler, no React. A hand-rolled type stripper was
 * tried first and broke on `const out: Toast[] = []`, which is exactly the
 * kind of thing a real transpiler is for.
 */
const ts = (await import("typescript")).default;

function loadFn(file, name) {
  const source = readFileSync(web(file), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.Preserve },
  }).outputText;
  // Drop the imports and anything that touches React; only the pure helpers
  // are wanted, and they are declared before any component that uses hooks.
  const body = js
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n");
  const start = body.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  let depth = 0, end = -1;
  for (let i = body.indexOf("{", start); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return new Function(`${body.slice(start, end)}; return ${name};`)();
}

// --- the status strip's one piece of logic ---------------------------------
{
  const humanUptime = loadFn("components/StatusStrip.tsx", "humanUptime");
  ok("seconds", humanUptime(45) === "45s");
  ok("minutes", humanUptime(600) === "10m");
  ok("hours", humanUptime(7200) === "2h");
  ok("days", humanUptime(200000) === "2d");
  // Nobody needs seconds from a number that means "a while".
  ok("coarse, not precise", humanUptime(3661) === "1h");
  ok("nothing is nothing", humanUptime(undefined) === "" && humanUptime(0) === "");
}

// --- when a toast is worth showing ------------------------------------------
{
  const newlySettled = loadFn("components/Toasts.tsx", "newlySettled");
  const s = (id, status, title = id) => ({ id, status, title });
  const prev = (pairs) => new Map(pairs);

  // Everything looks like it just changed when there is nothing to compare
  // against; a page load announcing six finished sessions is worse than
  // silence.
  ok("the first render says nothing", newlySettled(undefined, [s("a", "idle")], null).length === 0);

  ok("a session that finished is announced",
     newlySettled(prev([["a", "running"]]), [s("a", "idle")], null).length === 1);
  ok("an error is announced differently",
     newlySettled(prev([["a", "running"]]), [s("a", "error")], null)[0].tone === "error");
  ok("with the session's own name",
     /"my task" finished/.test(newlySettled(prev([["a", "running"]]), [s("a", "idle", "my task")], null)[0].text));

  // The open session shows its own state in every possible way already.
  ok("the session you are looking at is not toasted",
     newlySettled(prev([["a", "running"]]), [s("a", "idle")], "a").length === 0);

  ok("a session that was already idle is not announced",
     newlySettled(prev([["a", "idle"]]), [s("a", "idle")], null).length === 0);
  ok("nor one that is still running",
     newlySettled(prev([["a", "running"]]), [s("a", "running")], null).length === 0);
  ok("a session appearing for the first time is not announced",
     newlySettled(prev([]), [s("new", "idle")], null).length === 0);

  const many = newlySettled(prev([["a", "running"], ["b", "running"]]), [s("a", "idle"), s("b", "error")], null);
  ok("several at once are all reported", many.length === 2);
  ok("and each carries its session so it can be opened", many.every((t) => t.sessionId));
}

// --- mounted where it can be seen -------------------------------------------
{
  const sidebar = readFileSync(web("components/Sidebar.tsx"), "utf8");
  ok("the strip is in the sidebar", /<StatusStrip \/>/.test(sidebar));
  const app = readFileSync(web("App.tsx"), "utf8");
  ok("toasts are mounted at the top level", /<Toasts/.test(app));
  ok("and clicking one opens that session", /onOpen=\{\(id\) => navigate/.test(app));
}

// --- the events behind the transcript --------------------------------------
// The rendered conversation is an interpretation — tool calls grouped, results
// paired with their calls, framing hidden. Right almost always, and wrong
// exactly when something is behaving oddly, which is when the question becomes
// "what did the portal actually record?" The only answer was curl.
{
  const chat = readFileSync(web("components/Chat.tsx"), "utf8");
  ok("there is a raw event view", /\{raw \?/.test(chat));
  ok("with a toggle to reach it", /setRaw\(\(v\) => !v\)/.test(chat));
  ok("showing the payload", /JSON\.stringify\(ev\.payload/.test(chat));
  ok("and the seq, which is what a cursor is made of", /ev\.seq/.test(chat));
  // For a moment of confusion, not a way of working: left on, it would replace
  // a readable conversation with a wall of JSON on the next visit.
  ok("it is not remembered between visits", !/sessionStorage|localStorage/.test(chat));
}

// --- the one boundary worth moving ------------------------------------------
{
  const sidebar = readFileSync(web("components/Sidebar.tsx"), "utf8");
  ok("the sidebar can be dragged", /cursor-col-resize/.test(sidebar));
  ok("its width is state, not a class", /style=\{\{ width \}\}/.test(sidebar));
  // A sidebar dragged to nothing is a sidebar nobody can find again, and the
  // handle goes with it.
  ok("bounded at both ends", /Math\.min\(520, Math\.max\(180/.test(sidebar));
  ok("and remembered", /localStorage\.setItem\(WIDTH_KEY/.test(sidebar));
  ok("but survives a browser that refuses storage", /catch \{/.test(sidebar));
  // The listener closes over the width at mousedown, so what it saves has to
  // come from somewhere current.
  ok("it saves the width it ended on", /widthRef\.current/.test(sidebar));
}

// --- the sidebar can be got out of the way --------------------------------
// The trap to avoid: a toggle that lives inside the thing it hides. Chat's
// header hides it; App brings it back, and App's is rendered for every view
// because a collapsed sidebar on the Memory page would otherwise have nothing
// to click.
{
  const app = readFileSync(web("App.tsx"), "utf8");
  const chat = readFileSync(web("components/Chat.tsx"), "utf8");
  const sidebar = readFileSync(web("components/Sidebar.tsx"), "utf8");

  ok("the sidebar hides itself entirely", /if \(collapsed\) return null;/.test(sidebar));
  ok("the state is held above it, not inside", /const \[sidebarCollapsed, setSidebarCollapsed\]/.test(app));
  ok("and remembered", /phoenix\.sidebarCollapsed/.test(app));

  ok("the header hides it only while it is showing", /onToggleSidebar && !sidebarCollapsed/.test(chat));
  // The one that matters: the way back must not depend on being in a chat.
  ok("the way back is outside any one view", /\{sidebarCollapsed && \([\s\S]{0,400}Show the sidebar/.test(app));
  ok("and never competes with the header's toggle",
     app.indexOf("sidebarCollapsed && (") > 0 && /!sidebarCollapsed/.test(chat));

  /**
   * The count is shown even at zero.
   *
   * Hiding it when nothing runs was tried first, and absence is ambiguous —
   * you cannot tell "nothing is running" from "the count is not being drawn".
   * A grey nought answers the question; a missing badge only raises it.
   */
  ok("the running count is always drawn", !/\{runningCount > 0 && \(/.test(app));
  ok("and goes quiet rather than away",
     /runningCount > 0[\s\S]{0,60}text-accent[\s\S]{0,60}text-fg-faint/.test(app));
  ok("with the pulse only when something is running", /runningCount > 0 \? "animate-pulse/.test(app));
  ok("and a title that says so either way", /Nothing running — show the sidebar/.test(app));

  /**
   * An increase is what you would miss.
   *
   * The count says how much is going on and nothing about change — and a
   * session that begins while you are reading something else moves the number
   * and does nothing else, which is easy not to notice with the sidebar
   * hidden.
   */
  ok("an increase is noticed", /const grew = runningCount > lastCount\.current/.test(app));
  ok("and lights the badge", /justStarted[\s\S]{0,80}bg-accent\/15 text-accent/.test(app));
  ok("saying what happened", /Something just started/.test(app));
  // A badge that stayed lit would be saying "something started" long after it
  // stopped being news.
  ok("and it fades on its own", /setJustStarted\(false\), 6000/.test(app));
  ok("a decrease does not light it", /if \(!grew\) return;/.test(app));
}

// --- "working…" has to be live -------------------------------------------
// The session row is only refreshed for sessions in the sidebar list, and that
// list is task sessions — so the agent's own conversation carried whatever
// status it had at page load, forever, and "working…" never appeared in the
// one place you sit waiting for it.
{
  const chat = readFileSync(web("components/Chat.tsx"), "utf8");
  ok("running comes from the event stream", /e\.type !== "portal_status"/.test(chat));
  ok("with the row only as a fallback", /return session\.status === "running";/.test(chat));
  ok("and it is the last status that counts", /for \(let i = events\.length - 1/.test(chat));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
