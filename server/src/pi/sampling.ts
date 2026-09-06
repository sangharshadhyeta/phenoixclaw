import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Stop the model repeating itself, at the sampler rather than after the fact.
 *
 * The portal has grown three separate mitigations for repetition — a detector
 * for identical tool calls, one for a tool failing identically, and a
 * conversation recycler — and all three catch a *consequence*. The cause was
 * never looked at. Measured, on the server actually running here:
 *
 *     repeat_penalty:    1.0   (disabled)
 *     frequency_penalty: 0.0   (disabled)
 *     presence_penalty:  0.0   (disabled)
 *     dry_multiplier:    0.0   (disabled)
 *
 * Every anti-repetition mechanism in the sampler is off, which is llama.cpp's
 * default. Nothing was pushing the model away from emitting the same tokens
 * forever, so when a turn hit a wall — a `bash` whose directory had gone, a
 * `web_search` with no engine — it wrote "I'll try to use `bash` with `ls /`"
 * forty times, and "I'll just say Paris" forty more. That is not the model
 * being stubborn. It is a degenerate sampling loop with nothing to break it.
 *
 * ## Why DRY rather than a repetition penalty
 *
 * `repeat_penalty` and `frequency_penalty` work on individual tokens, and code
 * repeats individual tokens legitimately and constantly — `return`, `const`,
 * `self.`, a variable used twice in three lines. Penalising those makes the
 * model write worse code to avoid words it has already used.
 *
 * DRY penalises repeated *sequences*, which is exactly the failure mode: a
 * whole sentence emitted again verbatim. With `dry_allowed_length` at 8 it
 * ignores anything shorter than eight tokens, so ordinary syntax is untouched
 * and a repeated sentence is not.
 *
 * Verified before shipping, on this server: a module of four functions
 * generated with these settings still compiles and still has all four; a
 * prompt that asks for forty repetitions gets fewer.
 *
 * ## Why only for a local model
 *
 * These are llama.cpp's parameter names. Anthropic's API and OpenAI's reject
 * unknown fields outright, so sending them there would not degrade a session,
 * it would end it. The check is the provider's own base URL: a loopback or
 * private address is a server on this machine or this network, which is the
 * only case where these names mean anything. Anything else, or anything that
 * cannot be determined, is left exactly as it was.
 */

export interface Sampling {
  dry_multiplier: number;
  dry_base: number;
  dry_allowed_length: number;
  dry_penalty_last_n: number;
}

/**
 * Deliberately gentle.
 *
 * The purpose is to break a loop, not to change the model's voice. A
 * multiplier high enough to reshape ordinary prose would be trading one
 * quality problem for another, and the loops this exists for are extreme —
 * the same sentence dozens of times — so a light touch is enough to break
 * them.
 */
export const DEFAULT_SAMPLING: Sampling = {
  dry_multiplier: Number(process.env.PI_DRY_MULTIPLIER || 0.8),
  dry_base: Number(process.env.PI_DRY_BASE || 1.75),
  /**
   * Three, measured rather than reasoned.
   *
   * Eight was chosen on the theory that it should sit above any code idiom and
   * below any sentence. It was wrong in both directions. A live session
   * repeated "Actually, I'll respond." about thirty times inside one thinking
   * block — roughly seven tokens, so it slipped under the threshold entirely
   * and DRY never saw it.
   *
   * And the theory about code was backwards. Asked for a module of four
   * documented functions, this server produced, on the same prompt:
   *
   *     allowed_length 8 → 18 functions, does not compile
   *     allowed_length 4 → 18 functions, compiles
   *     allowed_length 3 →  4 functions, compiles
   *
   * and on a second prompt (a Stack class with four methods), 3 compiled while
   * 4 produced ten definitions and did not. The permissive window was not
   * protecting code; it was letting the model repeat itself into bloat.
   */
  dry_allowed_length: Number(process.env.PI_DRY_ALLOWED_LENGTH || 3),
  /**
   * The whole context, because the default is 64 tokens and that is why this
   * file did not work.
   *
   * `dry_penalty_last_n` is how far back DRY looks for the sequence it is
   * about to repeat. llama.cpp defaults it to 64 — read off this server's
   * /props — and a paragraph is longer than 64 tokens. So the loop that
   * prompted all of this, a whole "Actually, I'll provide the explanation in
   * reverse order / Let's try / Wait…" block repeated dozens of times, was
   * invisible to the sampler: by the time each cycle came round again, its own
   * first token had fallen out of the window being checked.
   *
   * Everything else here was set correctly and had no effect for that one
   * reason.
   *
   * A number rather than llama.cpp's documented -1 ("whole context"): this
   * server rejects it outright — `Field 'dry_penalty_last_n': Value must be
   * between 0 <= value <= 2147483647, but got -1` — which would have turned
   * every request into a 400. 8192 is comfortably longer than any block a
   * turn has looped on and well inside the 65536 window.
   */
  dry_penalty_last_n: Number(process.env.PI_DRY_PENALTY_LAST_N || 8192),
};

/** A loopback or private address — a server on this machine or this network. */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  /**
   * Anchored at both ends, because a prefix test is not an address test.
   *
   * `/^127\./` matches `127.0.0.1.evil.test`, which is a name someone else
   * controls resolving wherever they like — and it would have been treated as
   * a server on this machine. Caught by this file's own contract before it
   * shipped, which is the argument for writing the hostile case down.
   */
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const [a, b] = host.split(".").map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Whether this provider is a local llama.cpp, read from pi's own models.json.
 *
 * The same file that defines the provider, rather than a second list here that
 * would drift from it. Unreadable, missing or unrecognised means no — a wrong
 * "yes" ends every request with a 400, and a wrong "no" leaves things as they
 * are today.
 */
interface ModelsFile {
  providers?: Record<
    string,
    { baseUrl?: string; api?: string; models?: { id?: string; reasoning?: boolean }[] }
  >;
}

function readModelsFile(agentDir: string): ModelsFile | undefined {
  const file = path.join(agentDir, "models.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ModelsFile;
  } catch {
    return undefined;
  }
}

export function providerIsLocal(agentDir: string, provider: string | undefined): boolean {
  if (!provider) return false;
  const parsed = readModelsFile(agentDir);
  const config = parsed?.providers?.[provider];
  if (!config) return false;
  // OpenAI-compatible is what llama.cpp serves; a local Anthropic-shaped
  // endpoint would not take these names either.
  if (config.api && !/openai/i.test(config.api)) return false;
  return isLocalUrl(config.baseUrl);
}

/**
 * Whether this model has any reasoning to turn up.
 *
 * Read from the same file that declares it, rather than trusting a level
 * chosen for a different model: `models.json` marks this one
 * `"reasoning": false`, which is why pi's own state always reports its
 * effective thinking level as "off" regardless of the portal's global
 * default. A model not listed is assumed capable — the safe default is not
 * to suppress something that might be wanted.
 */
export function modelReasons(
  agentDir: string,
  provider: string | undefined,
  modelId: string | undefined,
): boolean {
  if (!provider) return true;
  const models = readModelsFile(agentDir)?.providers?.[provider]?.models;
  const entry = models?.find((m) => m.id === modelId);
  return entry?.reasoning !== false;
}

/**
 * Stop the model reasoning when nobody asked it to.
 *
 * This is a reasoning model, and its thinking comes out of the *same* token
 * budget as its answer — the reason `llm.ts` already sends this flag for
 * extraction calls. pi resolves a thinking level per session and clamps it to
 * what the model supports, which for this one is `off`; nothing ever told
 * llama.cpp. So the model deliberated on every turn regardless, and a task
 * asked for the square root of 144 spent 8192 output tokens thinking, hit
 * `finish_reason: length`, and produced no answer at all — the conversation
 * waiting on it was never told anything, because there was nothing to tell.
 *
 * Measured on this server, same question, same everything else:
 *
 *     without the flag → finish_reason "length", 610 chars of reasoning, content ""
 *     with the flag    → finish_reason "stop",   no reasoning,            content "12"
 *
 * Only when the level is `off`. Asking for thinking and then suppressing it
 * would be worse than either — this makes the configured level true, it does
 * not overrule it.
 */
export function withThinking(payload: unknown, thinkingLevel: string | undefined): unknown {
  if (!isChatBody(payload)) return undefined;
  /**
   * `thinkingLevel` here was the wrong value: it is `session.thinking_level ||
   * settings.thinkingLevel`, the *requested* level before pi clamps it to
   * what the model can actually do — "medium" by default, since that is the
   * portal's global default regardless of the model in use. This model's own
   * entry in models.json declares `"reasoning": false`, so pi always resolves
   * its *effective* level to "off" no matter what was requested — which is
   * exactly the case this function needs to catch, and exactly the one the
   * old check let through, because "medium" is not "off".
   *
   * The caller now passes whichever of the two already says "off": either the
   * level actually requested, or `modelReasons(...)` saying the model has no
   * reasoning to turn up in the first place. See samplingDefaults.
   */
  if (thinkingLevel && thinkingLevel !== "off") return undefined;
  const existing = (payload as { chat_template_kwargs?: Record<string, unknown> })
    .chat_template_kwargs;
  // An explicit value upstream wins, as everywhere else in this file.
  if (existing && "enable_thinking" in existing) return undefined;
  return {
    ...payload,
    chat_template_kwargs: { ...(existing ?? {}), enable_thinking: false },
  };
}

/**
 * A ceiling on what one generation may spend, output and thinking together.
 *
 * Ported from Sisyphean's own default: its OpenAI-compatible endpoint
 * (`engine/compat/openai_compat.py`) answers with `max_tokens=1024` whenever
 * a caller does not ask for something else, and its Anthropic-compatible one
 * (`engine/compat/anthropic.py`) clamps a caller's own request down to a
 * fixed ceiling rather than trusting it — `if self.max_tokens > LIMIT:
 * self.max_tokens = LIMIT`. Its step-driving loop (`translation/loop.py`)
 * calls with exactly this figure: `max_tokens=1024, thinking=False`.
 *
 * pi asks with the model's own declared `maxTokens` by default — 8192 for
 * this one — which is the ceiling that let the sqrt(144) turn spend its
 * entire budget on one tool-call argument before anything else could stop
 * it. Thinking suppression (`withThinking`, above) and this are two different
 * defences against the same failure: one asks the model not to reason at
 * length, this one bounds what happens if it does anyway — a stalled or
 * runaway generation now fails in 1024 tokens rather than 8192, which is a
 * cheaper mistake to recover from and a faster one to notice.
 *
 * A ceiling, not a floor: an explicit request for *less* is left alone, the
 * same as everywhere else in this file. Only a request for more than this —
 * which today is every ordinary turn, since pi's own default is the model's
 * full budget — gets pulled down to it.
 */
const MAX_GENERATION_TOKENS = Number(process.env.PI_MAX_GENERATION_TOKENS || 1024);

export function withMaxTokens(payload: unknown, limit = MAX_GENERATION_TOKENS): unknown {
  if (!isChatBody(payload)) return undefined;
  const existing = (payload as { max_tokens?: unknown }).max_tokens;
  if (typeof existing === "number" && existing <= limit) return undefined;
  return { ...payload, max_tokens: limit };
}

/** True when this payload looks like a chat-completions body we can add to. */
function isChatBody(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return false;
  return Array.isArray((payload as { messages?: unknown }).messages);
}

/**
 * Add the sampling parameters, unless something already set them.
 *
 * An explicit value anywhere upstream — a caller, an extension, a future
 * setting — wins. This is a default for a server that has none, not a policy.
 */
export function withSampling(payload: unknown, sampling: Sampling = DEFAULT_SAMPLING): unknown {
  if (!isChatBody(payload)) return undefined;
  if ("dry_multiplier" in payload) return undefined;
  if (!(sampling.dry_multiplier > 0)) return undefined;
  return { ...payload, ...sampling };
}

export function samplingDefaults(
  agentDir: string,
  provider: string | undefined,
  thinkingLevel?: string,
  modelId?: string,
) {
  return (pi: any): void => {
    if (!providerIsLocal(agentDir, provider)) return;
    // Whichever already says "off": the level actually requested, or the
    // model having nothing to turn up regardless of what was requested.
    const effectiveLevel =
      thinkingLevel === "off" || !modelReasons(agentDir, provider, modelId)
        ? "off"
        : thinkingLevel;
    pi.on("before_provider_request", async (event: any) => {
      const withDry = withSampling(event?.payload) ?? event?.payload;
      const withThink = withThinking(withDry, effectiveLevel) ?? withDry;
      return withMaxTokens(withThink) ?? withThink;
    });
  };
}
