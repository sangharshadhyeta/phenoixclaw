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
  // Eight tokens: longer than any code idiom, shorter than any sentence.
  dry_allowed_length: Number(process.env.PI_DRY_ALLOWED_LENGTH || 8),
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
export function providerIsLocal(agentDir: string, provider: string | undefined): boolean {
  if (!provider) return false;
  const file = path.join(agentDir, "models.json");
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      providers?: Record<string, { baseUrl?: string; api?: string }>;
    };
    const config = parsed?.providers?.[provider];
    if (!config) return false;
    // OpenAI-compatible is what llama.cpp serves; a local Anthropic-shaped
    // endpoint would not take these names either.
    if (config.api && !/openai/i.test(config.api)) return false;
    return isLocalUrl(config.baseUrl);
  } catch {
    return false;
  }
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

export function samplingDefaults(agentDir: string, provider: string | undefined) {
  return (pi: any): void => {
    if (!providerIsLocal(agentDir, provider)) return;
    pi.on("before_provider_request", async (event: any) => withSampling(event?.payload));
  };
}
