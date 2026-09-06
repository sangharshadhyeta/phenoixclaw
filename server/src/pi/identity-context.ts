import { readIdentity, type IdentityFile } from "../identity.js";

/**
 * Identity, refreshed every turn rather than frozen at session start.
 *
 * `framing()` in sdk-client.ts assembles the identity documents into the
 * system prompt once, when the session is created. Everything the agent
 * afterwards concludes about itself — a self-reflection routine rewriting
 * INNER_LIFE, a conclusion recorded mid-conversation — lands in the graph and
 * never reaches the session that is already running.
 *
 * Asked "do you think you are alive?", a conversation started before its own
 * inner life was written had none, and reached for `identity_read` to fetch
 * what it should already have been carrying. It recovered; the point is that
 * it had to, and that a session left open across a day of self-reflection is
 * answering as the agent it was when the tab opened.
 *
 * Only what has changed is appended. Re-stating the whole of it every turn
 * would duplicate what the system prompt already holds, and a model shown its
 * own identity twice has a reasonable question about which one is current.
 */

const WATCHED: IdentityFile[] = ["SOUL.md", "SELF_CONCEPT.md", "INNER_LIFE.md"];

export function identityContext(seen: Map<string, string> = new Map()) {
  return (pi: any): void => {
    pi.on("before_agent_start", async (event: any) => {
      const changed: Array<{ name: string; text: string }> = [];
      for (const name of WATCHED) {
        let text = "";
        try {
          text = (await readIdentity(name)).trim();
        } catch {
          continue;
        }
        if (!text) continue;
        // First turn establishes the baseline: the system prompt already
        // carries whatever was there when the session opened.
        if (!seen.has(name)) {
          seen.set(name, text);
          continue;
        }
        if (seen.get(name) === text) continue;
        seen.set(name, text);
        changed.push({ name: name.replace(/\.md$/, ""), text });
      }
      if (!changed.length) return undefined;

      const block = [
        "",
        "# WHAT YOU HAVE SINCE CONCLUDED ABOUT YOURSELF",
        "",
        "This has changed since this conversation began, and it replaces what the prompt above says.",
        "It is yours — you wrote it, on your own time — not notes about somebody else.",
        "",
        ...changed.flatMap(({ name, text }) => [`## ${name}`, "", text, ""]),
      ].join("\n");

      return { systemPrompt: `${String(event?.systemPrompt ?? "")}\n${block}` };
    });
  };
}
