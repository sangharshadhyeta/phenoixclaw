import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { countChannelSessions, getDb } from "../db.js";
import { agentHome } from "../agent.js";
import { isValidSlug, slugify } from "../slug.js";
import { channelSupervisor } from "../channels/supervisor.js";
import {
  channelsDir,
  installChannelPackage,
  loadChannels,
  removeChannelPackage,
  type ChannelField,
  type LoadedChannel,
} from "../channels/loader.js";

/**
 * A channel is a two-way link into the agent: messages arrive through it and
 * the agent's replies go back out the same way. Every channel points at the
 * same agent session, so they are different doors into one conversation.
 *
 * The kinds on offer are whatever channel packages are loaded — the builtins in
 * the repo and anything installed from GitHub or npm. Nothing is hardcoded
 * here, so a third-party package is a first-class citizen.
 */

const kindById = async (id: string) =>
  (await loadChannels()).channels.find((k) => k.id === id);

/** Only what the browser needs: the package's own code stays server-side. */
const kindToApi = (k: LoadedChannel) => ({
  id: k.id,
  label: k.label,
  blurb: k.blurb ?? "",
  fields: k.fields,
  packageName: k.packageName,
  version: k.version,
  builtin: k.builtin,
  runnable: Boolean(k.start),
});

interface ChannelRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  instructions: string;
  relay_progress: number;
  relay_tools: number;
  created_at: string;
  updated_at: string;
}

const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Strip secrets before anything leaves the process. The browser is told which
 * secrets are set — enough to render "configured" without handing back a token
 * that anyone with the page open could read.
 */
async function toApi(row: ChannelRow, kind?: LoadedChannel) {
  const config = parseConfig(row.config);
  const visible: Record<string, unknown> = {};
  const secretsSet: string[] = [];

  for (const field of kind?.fields ?? []) {
    if (field.secret) {
      if (config[field.key]) secretsSet.push(field.key);
    } else {
      visible[field.key] = config[field.key] ?? "";
    }
  }

  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    enabled: Boolean(row.enabled),
    config: visible,
    secretsSet,
    instructions: row.instructions ?? "",
    relayProgress: Boolean(row.relay_progress),
    relayTools: Boolean(row.relay_tools),
    /** Conversations keyed to this slug — what a delete would strand. */
    sessionCount: await countChannelSessions(row.slug),
    // What the supervisor is actually doing, not a hardcoded guess.
    ...channelSupervisor.status(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * A slug that is free. Agent sessions are keyed on it, so it must be unique —
 * two channels sharing one would merge their conversations.
 */
async function freeSlug(desired: string, exceptId?: string): Promise<string> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT id, slug FROM channels");
  const rows = reader.getRowObjectsJson() as unknown as { id: string; slug: string }[];
  const base = slugify(desired) || "channel";
  const taken = new Set(rows.filter((c) => c.id !== exceptId).map((c) => c.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error(`Could not find a free slug for "${desired}"`);
}

const missingRequired = (kind: LoadedChannel, config: Record<string, unknown>) =>
  kind.fields.filter((f) => f.required && !config[f.key]).map((f) => f.label);

export function channelsRouter(): Router {
  const router = express.Router();

  const rowById = async (id: string): Promise<ChannelRow | undefined> => {
    const conn = await getDb();
    const reader = await conn.runAndReadAll("SELECT * FROM channels WHERE id = $id", { id });
    return reader.getRowObjectsJson()[0] as unknown as ChannelRow | undefined;
  };

  router.get("/channels", async (_req, res) => {
    try {
      const { channels: kinds, broken } = await loadChannels();
      const byId = new Map(kinds.map((k) => [k.id, k]));
      const conn = await getDb();
      const reader = await conn.runAndReadAll("SELECT * FROM channels ORDER BY created_at ASC");
      const rows = reader.getRowObjectsJson() as unknown as ChannelRow[];

      res.json({
        channels: await Promise.all(rows.map((r) => toApi(r, byId.get(r.kind)))),
        kinds: kinds.map(kindToApi),
        broken,
        agentHome: agentHome(),
        channelsDir: channelsDir(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/channels", async (req, res) => {
    const { kind: kindId, name, config } = req.body ?? {};
    const kind = typeof kindId === "string" ? await kindById(kindId) : undefined;
    if (!kind) return res.status(400).json({ error: "Unknown channel type" });

    const clean = sanitise(kind, config, {});
    const missing = missingRequired(kind, clean);
    if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });

    const label = (typeof name === "string" && name.trim()) || kind.label;
    // An explicit slug reconnects a channel to the conversations it had before
    // it was deleted; without one it is derived from the name.
    const wanted = typeof req.body?.slug === "string" && req.body.slug.trim() ? req.body.slug : label;
    const slug = await freeSlug(wanted);

    const id = nanoid(10);
    const conn = await getDb();
    await conn.run(
      "INSERT INTO channels (id, slug, kind, name, config) VALUES ($id, $slug, $kind, $name, $config)",
      { id, slug, kind: kind.id, name: label, config: JSON.stringify(clean) },
    );
    void channelSupervisor.sync();
    res.json(await toApi((await rowById(id))!, kind));
  });

  router.patch("/channels/:id", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const kind = await kindById(row.kind);
    if (!kind) {
      return res.status(400).json({
        error: `No package provides "${row.kind}" — it may have been uninstalled`,
      });
    }

    const { name, enabled, config, instructions, slug, relayProgress, relayTools } =
      req.body ?? {};
    const sets: string[] = [];
    const params: Record<string, any> = { id: row.id };
    const conn = await getDb();

    if (typeof slug === "string" && slug.trim() && slug.trim() !== row.slug) {
      const next = slugify(slug);
      if (!isValidSlug(next)) {
        return res.status(400).json({ error: `"${slug}" is not a usable slug` });
      }
      const clashReader = await conn.runAndReadAll(
        "SELECT id FROM channels WHERE slug = $slug AND id != $id",
        { slug: next, id: row.id },
      );
      if (clashReader.getRowObjectsJson().length) {
        return res.status(409).json({ error: `Another channel already uses "${next}"` });
      }
      sets.push("slug = $slug");
      params.slug = next;
    }
    if (typeof name === "string" && name.trim()) {
      sets.push("name = $name");
      params.name = name.trim();
    }
    // Not trimmed to empty-means-unchanged: clearing the box should clear the
    // instructions, which is only expressible if "" is a real value.
    if (typeof instructions === "string") {
      sets.push("instructions = $instructions");
      params.instructions = instructions.trim();
    }
    if (typeof relayProgress === "boolean") {
      sets.push("relay_progress = $relayProgress");
      params.relayProgress = relayProgress ? 1 : 0;
    }
    if (typeof relayTools === "boolean") {
      sets.push("relay_tools = $relayTools");
      params.relayTools = relayTools ? 1 : 0;
    }
    if (typeof enabled === "boolean") {
      sets.push("enabled = $enabled");
      params.enabled = enabled ? 1 : 0;
    }
    if (config && typeof config === "object") {
      const merged = sanitise(kind, config, parseConfig(row.config));
      const missing = missingRequired(kind, merged);
      if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });
      sets.push("config = $config");
      params.config = JSON.stringify(merged);
    }
    if (sets.length) {
      sets.push("updated_at = now()");
      await conn.run(`UPDATE channels SET ${sets.join(", ")} WHERE id = $id`, params);
    }
    // Enabling, disabling or editing a token all mean the running channel is
    // stale; the supervisor restarts or stops it.
    await channelSupervisor.sync();
    res.json(await toApi((await rowById(row.id))!, kind));
  });

  /**
   * Removing a channel leaves its conversations behind rather than deleting
   * them — they are reconnected if it is recreated under the same slug. Pass
   * `?sessions=delete` to discard them instead.
   */
  router.delete("/channels/:id", async (req, res) => {
    const row = await rowById(req.params.id);
    if (!row) return res.json({ ok: true, stranded: 0, deleted: 0 });

    const conn = await getDb();
    const count = await countChannelSessions(row.slug);
    let deleted = 0;
    if (req.query.sessions === "delete") {
      const reader = await conn.runAndReadAll("SELECT id FROM sessions WHERE channel_slug = $slug", { slug: row.slug });
      const ids = reader.getRowObjectsJson() as unknown as { id: string }[];
      for (const s of ids) {
        await conn.run("DELETE FROM events WHERE session_id = $id", { id: s.id });
        await conn.run("DELETE FROM sessions WHERE id = $id", { id: s.id });
      }
      deleted = ids.length;
    }

    await conn.run("DELETE FROM channels WHERE id = $id", { id: row.id });
    void channelSupervisor.sync();
    res.json({ ok: true, slug: row.slug, stranded: deleted ? 0 : count, deleted });
  });

  // --- packages ---

  router.post("/channel-packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !spec.trim()) {
      return res.status(400).json({ error: "spec required" });
    }
    try {
      const output = await installChannelPackage(spec.trim());
      const { channels, broken } = await loadChannels(true);
      res.json({ ok: true, output, kinds: channels.map(kindToApi), broken });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/channel-packages/:name", async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const kind = (await loadChannels()).channels.find((k) => k.packageName === name);
    if (kind?.builtin) {
      return res.status(400).json({ error: "Builtin channels ship with the portal" });
    }
    // Configured channels of this kind are left in place deliberately: removing
    // the package should not silently discard credentials. They report the
    // missing package until it is reinstalled or the channel is deleted.
    try {
      await removeChannelPackage(name);
      const { channels, broken } = await loadChannels(true);
      res.json({ ok: true, kinds: channels.map(kindToApi), broken });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}

/**
 * Keep only fields the kind declares, and treat a blank secret as "unchanged" —
 * the browser never receives the stored token, so it cannot send it back, and
 * saving an unrelated field would otherwise wipe it.
 */
function sanitise(
  kind: LoadedChannel,
  incoming: unknown,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const input = (incoming && typeof incoming === "object" ? incoming : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};

  for (const field of kind.fields) {
    const value = input[field.key];
    if (field.secret) {
      if (typeof value === "string" && value.trim()) out[field.key] = value.trim();
      else if (value === null) continue; // explicit clear
      else if (existing[field.key]) out[field.key] = existing[field.key];
    } else if (typeof value === "string") {
      if (value.trim()) out[field.key] = value.trim();
    } else if (existing[field.key] !== undefined) {
      out[field.key] = existing[field.key];
    }
  }
  return out;
}
