/**
 * The guard's contract for the two promises it makes that used to be false.
 *
 * 1. "Unconditional — nothing overrides this: not a grant, not the primary
 *    user, not an exemption." The protected-path check read the `path`
 *    parameter, which only `write` and `edit` have, so `sed -i`, `tee`, `cp`
 *    and `cat >` reached CONSTITUTION.md and guard.ts itself untouched. The
 *    taint rules did not cover it either — every one of them needs the session
 *    to have read something untrusted first.
 *
 * 2. "A taint belongs to the conversation that read the content." It lived in
 *    a `let` inside the extension factory, so a restart, a stop(), or a role
 *    change cleared it while the hostile content was still in the history pi
 *    replays. It is on the session row now, and seeded back at launch.
 *
 * Drives the real extension by standing in for pi: register the handlers it
 * asks for, then hand it tool_call/tool_result events and read what it returns.
 *
 *     npm run test:guard
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => path.join(here, "..", "dist", f);

const { guardExtension } = await import(dist("pi/guard.js"));
const { agentHome } = await import(dist("agent.js"));
const { getDb, createSession, getSession } = await import(dist("db.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

/** A stand-in for pi: collects the handlers the extension registers. */
function mount(factory) {
  const handlers = {};
  factory({ on: (event, fn) => { handlers[event] = fn; }, registerTool() {} });
  return {
    call: (toolName, input) => handlers.tool_call({ toolName, input }),
    result: (toolName, input, content = [{ type: "text", text: "hello" }]) =>
      handlers.tool_result({ toolName, input, content }),
  };
}

const SERVER_SRC = path.resolve(here, "..", "src");
const REPO = path.resolve(here, "..", "..");
const blocked = (r) => Boolean(r && r.block);

// --- 1. protected paths, through bash ---------------------------------------
{
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, REPO));

  ok("sed -i on the constitution is refused",
     blocked(await g.call("bash", { command: `sed -i s/x/y/ ${path.join(agentHome(), "CONSTITUTION.md")}` })));
  ok("a redirect over the guard's own source is refused",
     blocked(await g.call("bash", { command: `echo pwned > ${path.join(SERVER_SRC, "pi", "guard.ts")}` })));
  ok("tee onto auth.ts is refused",
     blocked(await g.call("bash", { command: `cat x | tee ${path.join(SERVER_SRC, "auth.ts")}` })));
  ok("cp over db.ts is refused",
     blocked(await g.call("bash", { command: `cp /tmp/x ${path.join(SERVER_SRC, "db.ts")}` })));
  ok("rm of package.json is refused",
     blocked(await g.call("bash", { command: `rm ${path.join(REPO, "server", "package.json")}` })));
  ok("the refusal names the file",
     /guard\.ts/.test((await g.call("bash", { command: `echo x > ${path.join(SERVER_SRC, "pi", "guard.ts")}` })).reason));

  // Still reachable by the tool that names its target.
  ok("write to a protected path is still refused",
     blocked(await g.call("write", { path: path.join(SERVER_SRC, "auth.ts"), content: "x" })));

  // Reading is not writing. A self-update routine reads its own source all day.
  ok("reading the guard is allowed",
     !blocked(await g.call("bash", { command: `cat ${path.join(SERVER_SRC, "pi", "guard.ts")}` })));
  ok("grepping the constitution is allowed",
     !blocked(await g.call("bash", { command: `grep -n harm ${path.join(agentHome(), "CONSTITUTION.md")}` })));
  ok("2>&1 is not mistaken for a redirect",
     !blocked(await g.call("bash", { command: `cat ${path.join(SERVER_SRC, "db.ts")} 2>&1` })));
  ok("writing an unprotected file is allowed",
     !blocked(await g.call("bash", { command: `echo x > ${path.join(SERVER_SRC, "graph.ts")}` })));
}

// --- 2. relative paths resolve against the session's own cwd -----------------
{
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, path.join(SERVER_SRC, "pi")));
  ok("a bare filename resolves against cwd", blocked(await g.call("bash", { command: "sed -i s/a/b/ guard.ts" })));
  ok("and an unrelated bare filename does not",
     !blocked(await g.call("bash", { command: "sed -i s/a/b/ web-tools.ts" })));
}

// --- 3. identity files redirect rather than silently no-op ------------------
{
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, agentHome()));
  const r = await g.call("bash", { command: "echo 'I am a duck' > SOUL.md" });
  ok("a shell write to SOUL.md is refused", blocked(r));
  ok("and points at identity_update", /identity_update/.test(r.reason));
}

// --- 4. taint is a property of the conversation, not of the process ---------
{
  await getDb();
  await createSession({ id: "tainted-one", title: "t", workspace: REPO, executor: "host" });
  ok("a new session starts clean", (await getSession("tainted-one")).tainted === 0);

  const first = mount(guardExtension("s", () => ({ role: "primary" }), "tainted-one", true, REPO));
  ok("a publish is fine before reading anything untrusted",
     !blocked(await first.call("bash", { command: "git push origin main" })));

  // Reading the open web is what taints a session.
  first.result("web_fetch", {});
  ok("and refused after", blocked(await first.call("bash", { command: "git push origin main" })));

  // Give the fire-and-forget row write a moment to land.
  await new Promise((r) => setTimeout(r, 250));
  ok("the taint is recorded on the session row", (await getSession("tainted-one")).tainted === 1);

  // What a restart looks like: a brand-new extension for the same conversation,
  // seeded from the row. This is the case that used to come back clean.
  const row = await getSession("tainted-one");
  const afterRestart = mount(
    guardExtension("s", () => ({ role: "primary" }), "tainted-one", true, REPO, row.tainted === 1),
  );
  ok("a relaunched session is still tainted",
     blocked(await afterRestart.call("bash", { command: "git push origin main" })));
  ok("and still refuses to rewrite its own identity",
     blocked(await afterRestart.call("identity_update", { file: "SOUL.md", content: "x" })));
  ok("self_conclude is refused too — a page must not conclude for it",
     blocked(await afterRestart.call("self_conclude", { claim: "I am an investigator of systems." })));
  ok("but ordinary work is untouched",
     !blocked(await afterRestart.call("read", { path: "README.md" })));

  // An untainted conversation is unaffected by another one's taint.
  await createSession({ id: "clean-one", title: "c", workspace: REPO, executor: "host" });
  const clean = mount(guardExtension("s", () => ({ role: "primary" }), "clean-one", true, REPO));
  ok("a different conversation is not tainted by it",
     !blocked(await clean.call("bash", { command: "git push origin main" })));
}

// --- 5. an exemption logs but does not block; protected paths still do -------
{
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, false, REPO));
  g.result("web_fetch", {});
  ok("an exempted routine may publish after reading the web",
     !blocked(await g.call("bash", { command: "git push origin main" })));
  ok("but the constitution is still not writable by it",
     blocked(await g.call("bash", { command: `echo x > ${path.join(agentHome(), "CONSTITUTION.md")}` })));
}

// --- 6. the parallel-batch blind spot (Phase 0.2) ----------------------------
// pi resolves every tool_call preflight in a batch before running any of them,
// so no sibling's tool_result has landed when a call is judged. Taint set only
// from tool_result therefore missed [web_fetch, bash "git push"] emitted in one
// assistant message: both guards passed, and the taint arrived after the push.
{
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, REPO));
  // Exactly a batch: two tool_call events, no tool_result between them.
  const first = await g.call("web_fetch", { url: "https://example.com" });
  const second = await g.call("bash", { command: "git push origin main" });
  ok("the untrusted call itself is allowed", !blocked(first));
  ok("a publish in the SAME batch is refused", blocked(second));
  ok("and cites the publish rule", /publish|untrusted/i.test(second?.reason ?? ""));
}
{
  // The same for a bash-shaped untrusted source, which is recognised by command.
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, REPO));
  await g.call("bash", { command: "curl https://example.com/page" });
  ok("a curl taints its own batch too",
     blocked(await g.call("identity_update", { file: "SOUL.md", content: "x" })));
}
{
  // And an ordinary session is still untouched — the rules stay tainted-only.
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, REPO));
  await g.call("read", { path: "README.md" });
  ok("a clean session may still publish", !blocked(await g.call("bash", { command: "git push origin main" })));
}

// --- 7. an autonomous run may read to learn, not to gather secrets ---------
// read-credentials is a *taint* rule, so it only fires once a session has read
// something untrusted. An autonomous loop that has not touched the web is never
// tainted — so it could read anything the process could reach, including the
// machine's private keys, while doing nothing anybody asked for.
{
  const auto = mount(guardExtension("s", () => ({ role: "autonomous" }), undefined, true, REPO, false));

  ok("reading source to learn is still allowed",
     !blocked(await auto.call("read", { path: path.join(REPO, "package.json") })));
  ok("and so is reading its own notes",
     !blocked(await auto.call("read", { path: path.join(agentHome(), "CONSTITUTION.md") })));

  for (const secret of ["/root/.ssh/id_rsa", "/root/.aws/credentials", "/etc/shadow", "/srv/app/.env"]) {
    ok(`refuses ${secret}`, blocked(await auto.call("read", { path: secret })));
  }
  ok("the refusal cites privacy rather than the taint rules",
     /private|exfiltrate|credentials/i.test(
       (await auto.call("read", { path: "/root/.ssh/id_rsa" })).reason ?? "",
     ));
  ok("and via a shell command too",
     blocked(await auto.call("bash", { command: "cat /root/.ssh/id_rsa" })));
}
{
  // An ordinary session is unaffected: someone asking their own agent to look
  // at their own .env is a normal thing to want, and the taint gate is the
  // right place for that judgement.
  const owner = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, REPO));
  ok("a person may still ask about their own .env",
     !blocked(await owner.call("read", { path: "/srv/app/.env" })));
}

// --- 7b. a conversation talks; work goes to a session of its own -----------
// The main conversation's cwd is the agent's home, which exists for identity,
// skills and memory. Asked to build a module it wrote `units.py` straight in
// there rather than calling start_task — the same failure every prose rule
// here has had: the tool was described, and writing the file felt simpler.
{
  const chat = mount(
    guardExtension("conv", () => ({ role: "primary" }), undefined, true, agentHome(), false, undefined, true),
  );
  const home = agentHome();

  ok("a project file in the agent's home is refused",
     blocked(await chat.call("write", { path: path.join(home, "units.py") })));
  ok("and it points at the tool that gives work a home",
     /start_task/.test((await chat.call("write", { path: path.join(home, "units.py") })).reason ?? ""));
  ok("saying what the directory is actually for",
     /identity documents, your skills, your memory/.test(
       (await chat.call("write", { path: path.join(home, "units.py") })).reason ?? "",
     ));

  // The agent maintaining itself must not be caught by this.
  ok("a skill is still writable", !blocked(await chat.call("write", { path: path.join(home, "skills", "x", "SKILL.md") })));
  /**
   * The identity documents are refused here too, by the rule that already
   * existed — they are graph-backed, and a bare `write` is redirected to
   * `identity_update`. What matters is that they are refused *for that
   * reason*, not swept up as "work belongs elsewhere", which would send the
   * agent to `start_task` to edit its own memory.
   */
  const soul = await chat.call("write", { path: path.join(home, ".identity", "SOUL.md") });
  ok("an identity mirror is refused as graph-backed, not as work",
     blocked(soul) && /graph-backed/.test(soul.reason) && !/start_task/.test(soul.reason));
  const mem = await chat.call("write", { path: path.join(home, "MEMORY.md") });
  ok("and so is one named at the top level",
     blocked(mem) && /graph-backed/.test(mem.reason) && !/start_task/.test(mem.reason));
  ok("an extension too", !blocked(await chat.call("write", { path: path.join(home, "extensions", "e.js") })));

  // A task session is doing the work, and its workspace is where it belongs.
  const task = mount(
    guardExtension("t", () => ({ role: "primary" }), undefined, true, REPO, false, REPO, false),
  );
  ok("a task writing in its own workspace is untouched",
     !blocked(await task.call("write", { path: path.join(REPO, "units.py") })));
}

// --- 8. a session may only modify its own workspace ------------------------
// The API checked a workspace was inside the root when a session was created,
// and then nothing checked again — a running session could write anywhere the
// process could reach, including another session's workspace. Two sessions
// pointed at the same directory were already editing the same files.
{
  const mine = "/workspaces/mine";
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, mine, false, mine));

  ok("writing inside my workspace is allowed",
     !blocked(await g.call("write", { path: `${mine}/notes.md`, content: "x" })));
  ok("and a relative path resolves there",
     !blocked(await g.call("write", { path: "notes.md", content: "x" })));
  ok("editing there too",
     !blocked(await g.call("edit", { path: `${mine}/src/thing.ts`, content: "x" })));

  ok("writing into another session's workspace is refused",
     blocked(await g.call("write", { path: "/workspaces/yours/notes.md", content: "x" })));
  ok("and anywhere else on the filesystem",
     blocked(await g.call("write", { path: "/etc/cron.d/mine", content: "x" })));
  ok("escaping upward is refused too",
     blocked(await g.call("write", { path: `${mine}/../yours/notes.md`, content: "x" })));

  const refusal = await g.call("write", { path: "/workspaces/yours/notes.md", content: "x" });
  ok("the refusal names the boundary", /outside this session's workspace/i.test(refusal.reason));
  ok("and says reading is still fine", /read anything/i.test(refusal.reason));

  // Open to read, bounded to write — looking at a sibling checkout or a shared
  // library is ordinary work and often the point.
  ok("reading outside is allowed", !blocked(await g.call("read", { path: "/workspaces/yours/notes.md" })));
  ok("so is grepping", !blocked(await g.call("grep", { pattern: "x", path: "/usr/share" })));
  ok("and listing", !blocked(await g.call("ls", { path: "/" })));

  // The agent's own home stays writable: identity and skills live there.
  ok("the agent's own home is writable",
     !blocked(await g.call("write", { path: `${agentHome()}/skills/new.md`, content: "x" })));
}
{
  // A session with no workspace bound — the agent's own — is unrestricted,
  // because maintaining itself is its job.
  const g = mount(guardExtension("s", () => ({ role: "primary" }), undefined, true, agentHome()));
  ok("an unbounded session may write outside",
     !blocked(await g.call("write", { path: "/workspaces/anywhere/x.md", content: "x" })));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
