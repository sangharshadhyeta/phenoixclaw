import { Router, type Request, type Response } from "express";
import { checkPassword } from "../auth.js";
import { createSession, getSession, listSessions } from "../db.js";
import { sessions } from "../session-manager.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** The same root the portal's own session creation uses (see index.ts). */
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "/workspaces");

/**
 * The agent, reachable as a model.
 *
 * Sisyphean exposed an Anthropic Messages endpoint so any harness pointed at
 * it — Claude Code included — inherited its memory graph, its injector and its
 * permission guard without knowing any of that existed. The audit dismissed it
 * on the grounds that "statelessness is what Phoenixclaw inverts", which
 * answers a question nobody asked: the `SISYPHEAN_STATE` base64 smuggled
 * through thinking blocks *was* small-model-era scaffolding forced by having
 * nowhere to put state, and it is not the idea. The idea is a standard
 * endpoint in front of a stateful agent, which is strictly easier to build
 * here than it was there.
 *
 * ## What it does with the caller's history
 *
 * Ignores it, and says so. A Messages request carries the whole conversation
 * because the server is assumed to have no memory of it. This one does: the
 * portal owns the session, its event log and its graph. Replaying the caller's
 * transcript into a session that already lived through it would duplicate
 * every turn in the log and hand the model two copies of its own past. So the
 * last user message is the prompt, and everything before it is dropped.
 *
 * That is a real difference in behaviour, not a detail, which is why it is in
 * the response's `stop_reason` metadata and in the docs rather than left for
 * somebody to discover.
 *
 * ## Which session
 *
 * `metadata.user_id`, the one field the Messages API already carries for this
 * purpose. Same id, same session, same memory — which is the whole point of
 * pointing a harness at this rather than at a model. Without it each request
 * gets a fresh session, which is correct but wasteful, so the response says
 * which session answered.
 *
 * ## Authentication
 *
 * `x-api-key`, checked against `PORTAL_PASSWORD` — the convention every
 * Anthropic client already sends, so a caller needs no special configuration.
 * The portal's own cookie is not accepted here: a browser that has logged in
 * should not become a way for any page it visits to drive the agent.
 */

/** Pull the last thing a person said out of a Messages request. */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/** A stable session per caller id, so the same client keeps the same memory. */
async function sessionFor(userId: string | undefined): Promise<string> {
  const title = userId ? `api:${userId}`.slice(0, 120) : "";
  if (title) {
    const existing = (await listSessions()).find((s) => s.title === title);
    if (existing) return existing.id;
  }
  const id = Math.random().toString(36).slice(2, 14);
  /**
   * The same workspace a session created through the UI gets.
   *
   * This derived the path by climbing out of SESSION_ROOT — which points at
   * `data/sessions`, not the workspace root — and never made the directory. So
   * every session reached through this endpoint had a working directory that
   * did not exist, and `bash` refused every call with "Working directory does
   * not exist". Asked for 41 times 19, the model reported that its tool was
   * broken and then answered from its head anyway, wrongly.
   */
  const workspace = path.join(WORKSPACE_ROOT, `session-${id}`);
  mkdirSync(workspace, { recursive: true });
  await createSession({ id, title: title || `api:${id}`, workspace, executor: "host" });
  return id;
}

export function messagesRouter(): Router {
  const router = Router();

  router.post("/v1/messages", async (req: Request, res: Response) => {
    const key = req.header("x-api-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!checkPassword(key)) {
      return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid x-api-key." } });
    }

    const body = (req.body ?? {}) as Record<string, any>;
    if (body.stream === true) {
      /**
       * Refused rather than faked.
       *
       * A single non-streamed chunk dressed as a stream satisfies the schema
       * and lies about the thing the caller asked for — they wanted tokens as
       * they arrive, and would get one block after the whole turn. The portal
       * does stream, over SSE at `/api/sessions/:id/events`; mapping that onto
       * Anthropic's event shape is real work and is not done, so this says so.
       */
      return res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Streaming is not implemented on this endpoint. Send stream:false, or subscribe to " +
            "GET /api/sessions/:id/events for the portal's own stream.",
        },
      });
    }

    const prompt = lastUserText(body.messages);
    if (!prompt.trim()) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "No user message with any text in it." },
      });
    }

    try {
      const sessionId = await sessionFor(typeof body.metadata?.user_id === "string" ? body.metadata.user_id : undefined);
      const text = await sessions.ask(sessionId, prompt, { timeoutMs: 15 * 60_000, streamText: false });
      const row = await getSession(sessionId);
      return res.json({
        id: `msg_${sessionId}_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: row?.model ?? body.model ?? "phoenixclaw",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        // Not part of the Messages schema, and deliberately visible: this
        // endpoint has a memory of its own and did not read the transcript
        // that was sent to it.
        phoenixclaw: {
          session_id: sessionId,
          history: "ignored — this agent keeps its own; only the last user message was used",
        },
      });
    } catch (e) {
      return res.status(500).json({
        type: "error",
        error: { type: "api_error", message: (e as Error).message },
      });
    }
  });

  /**
   * The same agent, in the other dialect.
   *
   * Sisyphean exposed both because tools are split between them: Anthropic's
   * Messages shape and OpenAI's Chat Completions. The mapping is identical —
   * last user message becomes the prompt, `user` picks the session, the
   * caller's transcript is ignored because this agent has its own — so this is
   * a translation of the envelope and nothing else.
   *
   * Worth having rather than telling people to use the other one: an OpenAI
   * base-URL field is the single most common way a tool lets you point it
   * somewhere, and a portal reachable that way inherits its memory and guard
   * to anything that has one.
   */
  router.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const key = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? req.header("x-api-key");
    if (!checkPassword(key)) {
      return res.status(401).json({ error: { type: "invalid_request_error", message: "Invalid API key." } });
    }

    const body = (req.body ?? {}) as Record<string, any>;
    if (body.stream === true) {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message:
            "Streaming is not implemented on this endpoint. Send stream:false, or subscribe to " +
            "GET /api/sessions/:id/events for the portal's own stream.",
        },
      });
    }

    const prompt = lastUserText(body.messages);
    if (!prompt.trim()) {
      return res.status(400).json({
        error: { type: "invalid_request_error", message: "No user message with any text in it." },
      });
    }

    try {
      // `user` is OpenAI's equivalent of `metadata.user_id`, and serves the
      // same purpose here: same id, same session, same memory.
      const sessionId = await sessionFor(typeof body.user === "string" ? body.user : undefined);
      const text = await sessions.ask(sessionId, prompt, { timeoutMs: 15 * 60_000, streamText: false });
      const row = await getSession(sessionId);
      return res.json({
        id: `chatcmpl-${sessionId}-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: row?.model ?? body.model ?? "phoenixclaw",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        phoenixclaw: {
          session_id: sessionId,
          history: "ignored — this agent keeps its own; only the last user message was used",
        },
      });
    } catch (e) {
      return res.status(500).json({ error: { type: "server_error", message: (e as Error).message } });
    }
  });

  return router;
}
