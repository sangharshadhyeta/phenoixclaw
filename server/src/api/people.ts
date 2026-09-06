import express, { type Router } from "express";
import { forgetPerson, getPerson, listPeople, setRole, type Role } from "../people.js";
import { addToolRule, clearAudit, deleteToolRule, getDb, listAudit, listToolRules } from "../db.js";
import { nanoid } from "nanoid";

/**
 * The roster.
 *
 * Everyone who has ever spoken to the agent, including the ones it turned away
 * — that is the point. A stranger's id is recorded so you can promote them from
 * a list, rather than having to go and find their id on the platform.
 */

const ROLES: Role[] = ["primary", "colleague", "guest", "unknown"];

export function peopleRouter(): Router {
  const router = express.Router();

  router.get("/people", async (_req, res) => {
    res.json({ people: await listPeople() });
  });

  router.patch("/people/:key", async (req, res) => {
    const key = req.params.key;
    if (!(await getPerson(key))) return res.status(404).json({ error: "Not found" });

    const { role, name, notes } = req.body ?? {};
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}` });
    }
    const conn = await getDb();
    // One primary. Promoting somebody demotes whoever held it, rather than
    // leaving two people the agent treats as its owner.
    if (role === "primary") {
      await conn.run("UPDATE people SET role = 'colleague' WHERE role = 'primary' AND key != $key", { key });
    }
    if (typeof notes === "string") {
      await conn.run("UPDATE people SET notes = $notes WHERE key = $key", { notes: notes.trim(), key });
    }
    if (role) await setRole(key, role, typeof name === "string" ? name : undefined);
    else if (typeof name === "string" && name.trim()) {
      await conn.run("UPDATE people SET name = $name WHERE key = $key", { name: name.trim(), key });
    }
    res.json({ person: await getPerson(key) });
  });

  /**
   * What the guard has been deciding.
   *
   * Names are joined in rather than stored, so renaming somebody in the roster
   * renames them through the history too — the log records who, not what they
   * were called that week.
   */
  router.get("/audit", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const people = new Map((await listPeople()).map((p) => [p.key, p.name]));
    res.json({
      entries: (await listAudit(limit)).map((e) => ({
        ...e,
        person_name: e.person_key ? (people.get(e.person_key) ?? e.person_key) : null,
      })),
    });
  });

  /**
   * Empty the audit log.
   *
   * The counterpart to the graph purge, and it exists for the same reason:
   * everything else here prunes by age, which is right for a log that grows
   * steadily and useless after a day of testing has filled it with rows about
   * work that no longer exists.
   *
   * It is a record of what the agent did, so this is deliberately an explicit
   * action and nothing calls it on a schedule — losing the audit trail by
   * accident is exactly the kind of thing an audit trail is for.
   */
  router.post("/audit/clear", async (_req, res) => {
    const removed = await clearAudit();
    res.json({ ok: true, removed });
  });

  /** Exceptions: what a non-primary role is allowed to run despite the default. */
  router.get("/tool-rules", async (_req, res) => {
    // Names come from the roster: a rule showing a raw key is a rule nobody can
    // decide about.
    const people = new Map((await listPeople()).map((p) => [p.key, p.name]));
    res.json({
      rules: (await listToolRules()).map((r) => ({
        ...r,
        person_name: r.person_key ? (people.get(r.person_key) ?? r.person_key) : null,
      })),
    });
  });

  router.post("/tool-rules", async (req, res) => {
    const { role, tool, pattern, note } = req.body ?? {};
    if (!["colleague", "guest", "all"].includes(role)) {
      return res.status(400).json({ error: "Role must be colleague, guest or all" });
    }
    if (typeof tool !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(tool)) {
      return res.status(400).json({ error: "Tool must be a tool name, e.g. bash" });
    }
    if (typeof pattern !== "string" || !pattern.trim()) {
      return res.status(400).json({ error: "A pattern is required" });
    }
    // A bare "*" is not a rule, it is switching the whole thing off by accident.
    if (pattern.trim() === "*") {
      return res.status(400).json({
        error: "That allows everything — write the command you mean, with * only where it varies",
      });
    }
    await addToolRule({
      id: nanoid(10),
      role,
      tool,
      pattern: pattern.trim(),
      note: typeof note === "string" ? note.trim() : "",
      person_key: typeof req.body?.personKey === "string" ? req.body.personKey : null,
    });
    res.json({ rules: await listToolRules() });
  });

  router.delete("/tool-rules/:id", async (req, res) => {
    await deleteToolRule(req.params.id);
    res.json({ rules: await listToolRules() });
  });

  /**
   * Forgetting somebody is not the same as blocking them: the next message
   * makes them unknown again, which is refused and announced. Blocking is what
   * "unknown" already does.
   */
  router.delete("/people/:key", async (req, res) => {
    await forgetPerson(req.params.key);
    res.json({ ok: true });
  });

  return router;
}
