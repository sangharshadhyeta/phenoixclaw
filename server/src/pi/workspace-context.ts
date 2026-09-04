import { render } from "../workspace-snapshot.js";

/**
 * A fresh picture of the workspace on every LLM call.
 *
 * BirdClaw rebuilds this each turn rather than caching it, and the `context`
 * event is the equivalent seam here: it fires before each provider request
 * and hands the handler a `structuredClone` of the messages, so what is
 * written into it reaches the model for that one call and is then discarded.
 * Nothing accumulates in the transcript, and a session left running for a
 * week never reports the file listing it saw on Monday.
 *
 * The snapshot is attached to the *last user message* rather than appended as
 * a message of its own. A `context` handler runs on every call, including the
 * ones mid tool-loop, and a message inserted there would land between an
 * assistant's tool call and its tool result — a shape providers reject.
 * Appending a text block to a message that is already the user's cannot
 * change the conversation's shape at all.
 */
export function workspaceContext(cwd: string) {
  return (pi: any): void => {
    pi.on("context", (event: any) => {
      const text = render(cwd);
      if (!text) return undefined;

      const messages: any[] = Array.isArray(event.messages) ? event.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "user") continue;

        // Labelled, so the model reads it as ambient state rather than as
        // something the user just typed.
        const block = { type: "text", text: `<workspace-snapshot>\n${text}\n</workspace-snapshot>` };
        const content =
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }, block]
            : [...(Array.isArray(message.content) ? message.content : []), block];

        const next = messages.slice();
        next[i] = { ...message, content };
        return { messages: next };
      }
      // No user message yet — nothing to attach to, and nothing worth
      // reshaping the conversation for.
      return undefined;
    });
  };
}
