/**
 * One step, one context.
 *
 * Sisyphean gave each task in its plan a context holding only what that task
 * needed. The first feature audit read that as scaffolding for a 0.6B model and
 * threw it away. It is not scaffolding: attention thinning across a long
 * conversation, debris from earlier steps competing for it, and compaction
 * summarising by recency rather than relevance are not small-model problems.
 *
 * The brief is the whole design — too little and the step invents what it
 * cannot see, too much and this is an accumulating conversation with extra
 * steps — so most of this is about what is in it and what is kept out.
 *
 *     npm run test:steps
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { briefFor, runPlan, synthesisBrief, neededSections, signaturesOf } = await import(path.join(here, "..", "dist", "pi", "step-runner.js"));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

const task = (seq, description, status = "pending", result = "") => ({ seq, description, status, result });
const plan = [
  task(1, "Research the deployment story", "done", "found three sources, all agree on blue/green"),
  task(2, "Write the overview"),
  task(3, "Write the rollback section"),
];

// --- what a step is given ---------------------------------------------------
{
  const brief = briefFor({ goal: "Write a deployment guide", tasks: plan, step: plan[1] });

  ok("it is told the goal", /Write a deployment guide/.test(brief));
  ok("it is shown the whole plan", /Research the deployment story/.test(brief) && /rollback section/.test(brief));
  ok("and which step is its own", /← this one/.test(brief) && /→ \[2\]/.test(brief));

  // What earlier steps *produced*, not how they produced it. This is the line
  // between sufficient knowledge and the accumulating conversation.
  ok("it gets what earlier steps produced", /blue\/green/.test(brief));
  ok("but not their working", !/tool|grep|web_search/i.test(brief));

  // The single most effective line against a step that quietly does the next
  // three and leaves the plan describing work already finished.
  ok("it is told to do only this step", /only this step/.test(brief));
  // The runner marks it running itself. Leaving that to task_start is what
  // made write_next skip the step and file its text under the next one.
  ok("and not to announce a start the runner already recorded", /do not call it/.test(brief));
  ok("and how many are still to come", /1 more will follow/.test(brief));

  // Otherwise a fresh context reads as amnesia and the model goes looking for
  // what it thinks it has forgotten.
  ok("the missing conversation is explained, not left to be discovered", /fresh context, deliberately/.test(brief));
  ok("and it is told nothing was lost", /Nothing has been lost/.test(brief));
}

// --- the last step knows it is the last -------------------------------------
{
  const nearlyDone = [task(1, "a", "done", "did a"), task(2, "b")];
  const brief = briefFor({ goal: "g", tasks: nearlyDone, step: nearlyDone[1] });
  ok("the last step is told so", /This is the last step/.test(brief));
  ok("and is not told others will follow", !/more will follow/.test(brief));
}

// --- writing a document -----------------------------------------------------
{
  const written = `${"Earlier prose. ".repeat(200)}\n## The Overview\nSome text that ends here.`;
  const brief = briefFor({ goal: "g", tasks: plan, step: plan[1], file: "/w/guide.md", written });
  ok("it is shown the end of the file so the section follows on", /Some text that ends here/.test(brief));
  ok("not the whole of it", brief.length < written.length);
  ok("and told which tool appends", /write_next/.test(brief));

  const empty = briefFor({ goal: "g", tasks: plan, step: plan[1], file: "/w/guide.md", written: "" });
  ok("an empty file says so rather than showing nothing", /is empty so far/.test(empty));

  const noFile = briefFor({ goal: "g", tasks: plan, step: plan[1] });
  ok("a step with no document is pointed at task_finish", /task_finish/.test(noFile));
}

// --- the section this step actually needs -----------------------------------
// BirdClaw looks for the exact section matching the item before falling back to
// the tail of the file; this had only the fallback. The gap shows on the step
// that depends on the others: "describe", which uses area, perimeter and
// centroid, saw the last 1500 characters — so it had centroid and had to invent
// the signatures of the other two, in a file it had written itself.
{
  const text = "AAAA_area_body" + "x".repeat(40) + "BBBB_perimeter_body" + "y".repeat(40) + "CCCC_describe";
  const areaEnd = 14 + 40;
  const perimEnd = areaEnd + 19 + 40;
  const plan = [
    { seq: 1, description: "area", status: "done", result: `54 chars @0-${areaEnd}` },
    { seq: 2, description: "perimeter", status: "done", result: `59 chars @${areaEnd}-${perimEnd}` },
    { seq: 3, description: "describe, which uses area and perimeter", status: "pending", result: "" },
  ];

  const needed = neededSections(plan[2], plan, text);
  ok("a step that names an earlier section gets it", needed.length === 2);
  ok("with its actual text, sliced by the recorded span",
     /AAAA_area_body/.test(needed[0].body) && /BBBB_perimeter_body/.test(needed[1].body));

  // Not every earlier section: that is the accumulating context this exists to
  // avoid, arrived at by a different road.
  const lonely = neededSections(
    { seq: 3, description: "conclusion", status: "pending", result: "" },
    plan,
    text,
  );
  ok("a step that names nothing gets nothing extra", lonely.length === 0);

  const brief = briefFor({ goal: "g", tasks: plan, step: plan[2], file: "/w/m.mjs", written: text });
  ok("the needed section is in the brief in full", /AAAA_area_body/.test(brief));
  ok("said to be there so it is matched rather than guessed at", /match it rather than guess at it/.test(brief));
  ok("and what exists is listed", /Written so far: area, perimeter/.test(brief));
  ok("with the tail still shown", /The file ends like this/.test(brief));

  // A section name too short to match safely must not match everything.
  const tiny = neededSections(
    { seq: 2, description: "a discussion of everything", status: "pending", result: "" },
    [{ seq: 1, description: "a", status: "done", result: "5 chars @0-5" }],
    "hello world",
  );
  ok("a one-letter section name does not match every step", tiny.length === 0);

  // A span pointing past the end of the file is stale, not a slice to take.
  const stale = neededSections(plan[2], [{ seq: 1, description: "area", status: "done", result: "9 chars @0-9999" }], text);
  ok("a span past the end of the file is ignored", stale.length === 0);
}

// --- what is already defined, for the step that needs it most ---------------
// neededSections only fires when a step's description names an earlier one,
// and in a real plan the sections are bare nouns — "area", "perimeter",
// "describe" — so the dependency the person stated ("a describe function that
// uses all three") is nowhere in the step text. The step that needs the others
// most is exactly the one whose name says least.
{
  const code = [
    "/** Doc comment. */",
    "export function area(width, height) {",
    "  return width * height;",
    "}",
    "export const scale = (x) => x * 2;",
    "async function helper(a) {",
    "  return a;",
    "}",
  ].join("\n");

  const sigs = signaturesOf(code);
  ok("declarations are found", sigs.some((s) => /export function area\(width, height\)/.test(s)));
  ok("arrow constants too", sigs.some((s) => /scale/.test(s)));
  ok("and async functions", sigs.some((s) => /helper/.test(s)));
  ok("bodies are not included", !sigs.some((s) => /return width \* height/.test(s)));
  ok("nor doc comments", !sigs.some((s) => /Doc comment/.test(s)));
  ok("prose gets its headings", signaturesOf("## Rollback\nsome text").some((s) => /## Rollback/.test(s)));
  ok("plain prose yields nothing to show", signaturesOf("just a paragraph of words").length === 0);

  const plan = [
    { seq: 1, description: "area", status: "done", result: "10 chars @0-10" },
    { seq: 2, description: "describe", status: "pending", result: "" },
  ];
  const brief = briefFor({ goal: "g", tasks: plan, step: plan[1], file: "/w/m.mjs", written: code });
  ok("the step is shown what the file already defines", /export function area\(width, height\)/.test(brief));
  ok("said to be there so it matches rather than guesses", /matches it rather than guessing/.test(brief));
  // Only the signature block is body-free; the tail below it is the end of
  // the file and legitimately contains code.
  const sigBlock = brief.split("already defines")[1]?.split("ends like this")[0] ?? "";
  ok("without the bodies", sigBlock.length > 0 && !sigBlock.includes("return width * height"));
}

// --- a failed earlier step is not hidden ------------------------------------
{
  const withFailure = [task(1, "Check the API", "failed", "the endpoint no longer exists"), task(2, "Write it up")];
  const brief = briefFor({ goal: "g", tasks: withFailure, step: withFailure[1] });
  ok("a dead end is carried forward, not quietly dropped", /no longer exists/.test(brief));
  ok("and marked as one", /did not work out/.test(brief));
}

// --- the supervisor reaches the step ----------------------------------------
{
  const brief = briefFor({
    goal: "g", tasks: plan, step: plan[1],
    supervision: { verdict: "deepen", note: "You have not checked the version." },
  });
  ok("a nudge is carried into the step's own context", /have not checked the version/.test(brief));
}

// --- the step is started before it is asked for -----------------------------
{
  const started = [];
  await runPlan("g", {
    tasks: async () => [task(1, "one"), task(2, "two")],
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => "",
    start: async (seq) => started.push(seq),
  });
  ok("the runner marks the step running itself", started[0] === 1);
}

// --- the loop ---------------------------------------------------------------
{
  // Each step gets a fresh conversation, and the recycle happens *before* the
  // step: the turn that wrote the plan carries every false start that went
  // into writing it, so the first step should not inherit that either.
  const state = [task(1, "one"), task(2, "two")];
  const order = [];
  const briefs = [];
  const outcome = await runPlan("g", {
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({}),
    recycle: async () => order.push("recycle"),
    ask: async (message) => {
      order.push("ask");
      briefs.push(message);
      const next = state.find((t) => t.status === "pending");
      if (next) { next.status = "done"; next.result = "done it"; }
      return "";
    },
  });
  ok("it works the whole plan", outcome === "finished");
  ok("one conversation per step, plus the closing one", order.filter((x) => x === "ask").length === 3);
  ok("and each is recycled before it, not after",
     order.join(",") === "recycle,ask,recycle,ask,recycle,ask");

  // Every step's context knew only its own piece, so by construction none of
  // them saw the whole. Without a closing turn the person who asked gets the
  // last step's output as the answer to their question.
  const closing = briefs[briefs.length - 1];
  ok("the run ends by actually answering", /NOW ANSWER/.test(closing));
  ok("with what every step produced in one place", /done it/.test(closing));
  ok("told to answer as itself, not to report a process", /in your own voice, as yourself/.test(closing));
  ok("and warned it was not there for most of it", /you were not there for most of it/.test(closing));
}

// --- it must not loop on a step that will not close -------------------------
{
  let asks = 0;
  const notes = [];
  const outcome = await runPlan("g", {
    tasks: async () => [task(1, "a step that never finishes")],
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => { asks++; return ""; },
    note: async (t) => notes.push(t),
  });
  ok("a step that does not close is not retried", asks === 1);
  ok("the run stops rather than spinning", outcome === "stalled");
  ok("and says so, naming the step", /did not complete/.test(notes[0] ?? "") && /a step that never finishes/.test(notes[0] ?? ""));
  ok("while making clear nothing was lost", /intact/.test(notes[0] ?? ""));
}

// --- nothing to do ----------------------------------------------------------
{
  ok("no plan is not an error",
     (await runPlan("g", { tasks: async () => [], document: async () => ({}), recycle: async () => {}, ask: async () => "" })) === "no-plan");

  let asked = false;
  const done = await runPlan("g", {
    tasks: async () => [task(1, "a", "done", "x")],
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => { asked = true; return ""; },
  });
  // Not answered again, either: the closing turn belongs to work that just
  // happened, and firing it on arrival would re-answer a question already
  // answered, in a fresh context, out of nowhere.
  ok("a plan that was already finished is left alone", done === "finished" && !asked);
}

// --- the supervisor can stop it ---------------------------------------------
{
  const state = [task(1, "one"), task(2, "two"), task(3, "three")];
  let asks = 0;
  const notes = [];
  const outcome = await runPlan("g", {
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => {
      asks++;
      const next = state.find((t) => t.status === "pending");
      next.status = "done"; next.result = "r";
      return "";
    },
    supervise: async () => ({ verdict: "off-track", note: "This stopped serving what was asked." }),
    note: async (t) => notes.push(t),
  });
  ok("work that has left the request is stopped", outcome === "off-track");
  ok("after the step in flight, not mid-step", asks === 1);
  ok("and the reason is recorded", /stopped serving what was asked/.test(notes[0] ?? ""));
}

// --- the closing turn earns its place ---------------------------------------
// It exists because each isolated step saw only its own piece. When only one
// brief was ever issued that is not true — that turn saw everything and has
// already answered — and the first run to synthesise anyway re-read the file
// and pasted the whole module back.
{
  const state = [task(1, "one"), task(2, "two")];
  const briefs = [];
  await runPlan("g", {
    // One brief, and the turn closes every step — which is what a model that
    // ignores "only this step" actually does.
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({ file: "/w/out.md" }),
    recycle: async () => {},
    ask: async (m) => {
      briefs.push(m);
      for (const t of state) { t.status = "done"; t.result = "r"; }
      return "";
    },
    verify: async () => [],
  });
  ok("one context that did everything is not asked to summarise itself", briefs.length === 1);
  ok("and that one brief was a step, not a synthesis", /THIS STEP/.test(briefs[0]));

  // But a run that really was split still gets its closing turn.
  const split = [task(1, "one"), task(2, "two")];
  const twoBriefs = [];
  await runPlan("g", {
    tasks: async () => split.map((t) => ({ ...t })),
    document: async () => ({ file: "/w/out.md" }),
    recycle: async () => {},
    ask: async (m) => {
      twoBriefs.push(m);
      const next = split.find((t) => t.status === "pending");
      if (next) { next.status = "done"; next.result = "r"; }
      return "";
    },
    verify: async () => [],
  });
  ok("a genuinely split run is still assembled at the end", /NOW ANSWER/.test(twoBriefs[twoBriefs.length - 1]));

  // And a defect always earns one, however few briefs there were: an answer
  // that says "done" over a file that does not parse is the whole point.
  const broken = [task(1, "one")];
  const brokenBriefs = [];
  await runPlan("g", {
    tasks: async () => broken.map((t) => ({ ...t })),
    document: async () => ({ file: "/w/out.mjs" }),
    recycle: async () => {},
    ask: async (m) => {
      brokenBriefs.push(m);
      for (const t of broken) { t.status = "done"; t.result = "r"; }
      return "";
    },
    verify: async () => ["It does not parse: unexpected token"],
  });
  ok("a defect is always reported, however short the run", /does not parse/.test(brokenBriefs.join("\n")));
}

// --- the supervisor decides finished, or not yet ----------------------------
{
  // "Not deep enough" sends work back — but only so far. There is no depth at
  // which a sufficiently demanding reader runs out of things to want.
  const state = [task(1, "one")];
  let extensions = 0;
  const notes = [];
  await runPlan("g", {
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => {
      const next = state.find((t) => t.status === "pending");
      if (next) { next.status = "done"; next.result = "r"; }
      return "";
    },
    supervise: async () => ({ verdict: "deepen", note: "Nothing was actually checked." }),
    extend: async () => { extensions++; state.push(task(state.length + 1, `more ${extensions}`)); return true; },
    note: async (t) => notes.push(t),
  });
  ok("a plan judged thin is sent back for more", extensions > 0);
  ok("and the reason is recorded", /Nothing was actually checked/.test(notes[0] ?? ""));
  ok("but not forever", extensions <= 2);
}

{
  // "You have enough" ends the gathering, not the work: the remaining steps are
  // more of what there is already enough of.
  const state = [task(1, "one"), task(2, "two"), task(3, "three")];
  let skipped = false;
  const notes = [];
  await runPlan("g", {
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({}),
    recycle: async () => {},
    ask: async () => {
      const next = state.find((t) => t.status === "pending");
      if (next) { next.status = "done"; next.result = "r"; }
      return "";
    },
    supervise: async () => ({ verdict: "synthesize", note: "You have what you need." }),
    skipRemaining: async () => {
      skipped = true;
      for (const t of state) if (t.status === "pending") { t.status = "failed"; t.result = "skipped"; }
    },
    note: async (t) => notes.push(t),
  });
  ok("enough gathered stops the gathering", skipped);
  ok("and says so", /Enough gathered/.test(notes[0] ?? ""));
}

{
  // But never the deliverable. A live run wrote area, perimeter and centroid,
  // and the supervisor skipped "describe" — which the person had asked for by
  // name — recording it as "not needed". Whether there is enough to work from
  // is the supervisor's call; whether the thing asked for is worth delivering
  // is not.
  const state = [task(1, "area"), task(2, "perimeter"), task(3, "describe")];
  let skipped = false;
  await runPlan("g", {
    tasks: async () => state.map((t) => ({ ...t })),
    document: async () => ({ file: "/w/geometry.mjs", written: "some code" }),
    recycle: async () => {},
    ask: async () => {
      const next = state.find((t) => t.status === "pending");
      if (next) { next.status = "done"; next.result = "10 chars @0-10"; }
      return "";
    },
    supervise: async () => ({ verdict: "synthesize", note: "You have what you need." }),
    skipRemaining: async () => { skipped = true; },
    verify: async () => [],
  });
  ok("sections of a document are never skipped as 'not needed'", !skipped);
  ok("and every one of them is written", state.every((t) => t.status === "done"));
}

// --- the closing answer names what failed -----------------------------------
{
  const brief = synthesisBrief({
    goal: "Write the guide",
    tasks: [task(1, "intro", "done", "200 chars"), task(2, "check the API", "failed", "endpoint is gone")],
    file: "/w/guide.md",
  });
  ok("a failed step is named in the closing turn", /check the API/.test(brief));
  ok("with the reason not quietly dropped", /endpoint is gone/.test(brief));
  ok("and omitting it called out as worse", /worse than a shorter one/.test(brief));
  ok("the artefact is pointed at", /\/w\/guide\.md/.test(brief));
  // The first run to reach this pasted the whole module back in a code block:
  // reasonable when the file is not in front of you, but it is on disk and a
  // copy in the chat goes stale the moment either changes.
  ok("and not to be pasted back", /Do not paste it back/.test(brief));
  ok("with somewhere to get it instead", /open the file/.test(brief));

  const clean = synthesisBrief({ goal: "g", tasks: [task(1, "a", "done", "r")] });
  ok("a run with no failures is not told to apologise for one", !/did not work/.test(clean));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
