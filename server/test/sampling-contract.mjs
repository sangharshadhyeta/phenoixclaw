/**
 * Stopping repetition at the sampler, rather than after the fact.
 *
 * The portal grew three mitigations for repetition — identical tool calls, a
 * tool failing identically, a conversation recycler — and all three catch a
 * consequence. Measured on the server actually running here, every
 * anti-repetition mechanism in the sampler was off:
 *
 *     repeat_penalty 1.0, frequency_penalty 0.0, presence_penalty 0.0,
 *     dry_multiplier 0.0
 *
 * which is llama.cpp's default. Nothing pushed the model away from emitting
 * the same tokens forever, so a turn that hit a wall wrote "I'll just say
 * Paris" forty times.
 *
 * The risk to guard against is the opposite one: these are llama.cpp's
 * parameter names, and Anthropic's and OpenAI's APIs reject unknown fields
 * outright. Sending them to a cloud provider would not degrade a session, it
 * would end it. Most of this is about that.
 *
 *     npm run test:sampling
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { isLocalUrl, providerIsLocal, withSampling, withThinking, modelReasons, samplingDefaults, DEFAULT_SAMPLING } =
  await import(
  path.join(here, "..", "dist", "pi", "sampling.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- what counts as local ---------------------------------------------------
{
  ok("loopback", isLocalUrl("http://127.0.0.1:8099/v1"));
  ok("localhost", isLocalUrl("http://localhost:8099/v1"));
  ok("a private range", isLocalUrl("http://192.168.1.20:8099/v1"));
  ok("and the other private ranges", isLocalUrl("http://10.0.0.5/v1") && isLocalUrl("http://172.16.4.4/v1"));

  // A wrong "yes" ends every request with a 400.
  ok("a public host is not local", !isLocalUrl("https://api.anthropic.com/v1"));
  ok("nor is one that merely looks like it", !isLocalUrl("https://127.0.0.1.evil.test/v1"));
  ok("nor 172.32, which is outside the private range", !isLocalUrl("http://172.32.0.1/v1"));
  ok("nonsense is not local", !isLocalUrl("not a url") && !isLocalUrl(undefined));
}

// --- reading pi's own provider list -----------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "sampling-"));
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "local-llama": { baseUrl: "http://127.0.0.1:8099/v1", api: "openai-completions" },
        anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
        "local-anthropic": { baseUrl: "http://127.0.0.1:9000", api: "anthropic-messages" },
        "remote-openai": { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
      },
    }),
  );

  ok("a local llama provider is recognised", providerIsLocal(dir, "local-llama"));
  ok("a cloud provider is not", !providerIsLocal(dir, "anthropic"));
  ok("nor a remote OpenAI-compatible one", !providerIsLocal(dir, "remote-openai"));
  // A local Anthropic-shaped endpoint would not take these names either.
  ok("nor a local endpoint speaking another dialect", !providerIsLocal(dir, "local-anthropic"));

  // Unknown means no: a wrong yes is fatal, a wrong no leaves things as today.
  ok("an unknown provider is not assumed local", !providerIsLocal(dir, "who-knows"));
  ok("no provider at all is not", !providerIsLocal(dir, undefined));
  ok("a missing models.json is not", !providerIsLocal(mkdtempSync(path.join(tmpdir(), "empty-")), "local-llama"));

  const broken = mkdtempSync(path.join(tmpdir(), "broken-"));
  writeFileSync(path.join(broken, "models.json"), "{not json");
  ok("an unreadable one is not", !providerIsLocal(broken, "local-llama"));
}

// --- what is added ----------------------------------------------------------
{
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const out = withSampling(body);
  // DRY penalises repeated *sequences*. Token-level penalties damage code,
  // which repeats `return`, `const` and `self.` legitimately and constantly.
  ok("DRY is set", out.dry_multiplier === DEFAULT_SAMPLING.dry_multiplier && out.dry_multiplier > 0);
  /**
   * Short, and measured rather than reasoned.
   *
   * Eight was chosen on the theory that it sits above any code idiom and below
   * any sentence, and it was wrong both ways: a session repeated "Actually,
   * I'll respond." about thirty times in one thinking block — roughly seven
   * tokens, under the threshold — and on a four-function module this server
   * produced 18 functions that did not compile at 8, and exactly 4 that did
   * at 3.
   */
  ok("the window is short enough to catch a repeated sentence", out.dry_allowed_length <= 4);
  ok("and not zero, which would penalise every phrase", out.dry_allowed_length >= 2);
  ok("and nothing token-level", !("repeat_penalty" in out) && !("frequency_penalty" in out));
  ok("the rest of the payload survives", out.model === "m" && out.messages.length === 1);

  // A default for a server that has none, not a policy.
  ok("an explicit setting upstream wins",
     withSampling({ ...body, dry_multiplier: 0 }) === undefined);
  ok("a payload it does not recognise is untouched", withSampling({ prompt: "not chat" }) === undefined);
  ok("and so is nothing at all", withSampling(undefined) === undefined);
  ok("a multiplier of zero disables it",
     withSampling(body, { ...DEFAULT_SAMPLING, dry_multiplier: 0 }) === undefined);
}

// --- the extension only mounts for a local provider -------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "mount-"));
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:8099/v1", api: "openai-completions" } } }),
  );
  const mount = (provider) => {
    let handler;
    samplingDefaults(dir, provider)({ on: (e, fn) => { if (e === "before_provider_request") handler = fn; }, registerTool() {} });
    return handler;
  };
  ok("a local provider gets the handler", typeof mount("local") === "function");
  // The one that matters: a cloud session must not have these names anywhere
  // near its request.
  ok("a cloud provider gets none at all", mount("anthropic") === undefined);
  ok("and neither does an unknown one", mount(undefined) === undefined);
}

// --- the model's own declared capability, not the requested level -----------
// `thinkingLevel` passed around the portal is the *requested* level — the
// global default, "medium", regardless of what any particular model can do.
// pi clamps its own effective level to what the model supports, and this
// server's model declares `"reasoning": false` in models.json: pi always
// resolves it to "off" no matter what was requested, but a check against the
// requested level saw "medium" and did nothing. That is the live failure this
// contract is here to catch: the model reasoned unbounded through 8192 output
// tokens computing a square root and produced no answer, because "medium" is
// not the literal string "off".
{
  const dir = mkdtempSync(path.join(tmpdir(), "reasoning-"));
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "local-llama": {
          baseUrl: "http://127.0.0.1:8099/v1",
          api: "openai-completions",
          models: [
            { id: "no-reasoning-model", reasoning: false },
            { id: "reasoning-model", reasoning: true },
          ],
        },
      },
    }),
  );
  ok("a model marked reasoning:false has nothing to turn up",
     !modelReasons(dir, "local-llama", "no-reasoning-model"));
  ok("a model marked reasoning:true does",
     modelReasons(dir, "local-llama", "reasoning-model"));
  ok("a model not listed at all is assumed capable — the safe default",
     modelReasons(dir, "local-llama", "unlisted-model"));
  ok("no provider at all is assumed capable", modelReasons(dir, undefined, "no-reasoning-model"));

  // What samplingDefaults actually sends, for the exact case that looped.
  const calls = [];
  const pi = { getAgentDir: () => dir, on: (_evt, fn) => calls.push(fn) };
  samplingDefaults(dir, "local-llama", "medium", "no-reasoning-model")(pi);
  const handler = calls[0];
  const sent = await handler({ payload: { messages: [{ role: "user", content: "hi" }] } });
  ok("the requested level was 'medium', and the flag was sent anyway",
     sent?.chat_template_kwargs?.enable_thinking === false);
}

// --- the configured thinking level must reach the server ------------------
// This is a reasoning model whose thinking comes out of the same budget as its
// answer. pi resolves a thinking level and clamps it to what the model
// supports — `off` for this one — and nothing ever told llama.cpp, so it
// deliberated on every turn regardless. A task asked for the square root of
// 144 spent 8192 output tokens thinking, hit finish_reason "length" and
// produced no answer at all.
//
// Measured on the server, same question: without the flag, finish_reason
// "length" and empty content; with it, "12".
{
  const body = { messages: [{ role: "user", content: "hi" }] };
  const off = withThinking(body, "off");
  ok("thinking off is sent to the template",
     off?.chat_template_kwargs?.enable_thinking === false);
  ok("and the rest of the payload is untouched",
     Array.isArray(off?.messages) && off.messages.length === 1);
  ok("a level that is not off is left alone", withThinking(body, "medium") === undefined);
  ok("an undefined level counts as off",
     withThinking(body, undefined)?.chat_template_kwargs?.enable_thinking === false);
  ok("an explicit value upstream wins",
     withThinking({ ...body, chat_template_kwargs: { enable_thinking: true } }, "off") === undefined);
  ok("other template kwargs are preserved",
     withThinking({ ...body, chat_template_kwargs: { foo: 1 } }, "off")?.chat_template_kwargs?.foo === 1);
  ok("something that is not a chat body is left alone", withThinking({ nope: 1 }, "off") === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
