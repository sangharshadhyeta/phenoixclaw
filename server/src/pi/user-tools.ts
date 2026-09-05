import { Type } from "typebox";
import { rememberUser, USER_CATEGORIES } from "../user-knowledge.js";

/**
 * `remember_user` — BirdClaw's soul-loop tool of the same purpose, which it
 * calls in real time as the user reveals something rather than waiting for a
 * reflection pass to notice it retroactively.
 *
 * Registered only where it means anything: a conversation with the primary
 * user. What a colleague says about themselves is not knowledge about your
 * primary user, and filing it under one would put a stranger's stated
 * preferences into the prompt of every future session — which is both wrong
 * and the obvious way to attack this.
 */
export function userTools() {
  return (pi: any): void => {
    pi.registerTool({
      name: "remember_user",
      label: "Remember about the user",
      description:
        "Record something you have learned about the person you work for, as they reveal it — a fact, " +
        "a preference, an interest, or a rule about how they want you to work. Use `behaviors` for " +
        "instructions about your own conduct (\"don't pad answers\", \"show the command first\"): those " +
        "are kept ahead of everything else. Say it in one sentence, in your own words. Near-duplicates " +
        "of something already known strengthen it rather than adding a second copy.",
      promptSnippet: "remember_user — record a fact or preference about your primary user",
      parameters: Type.Object({
        fact: Type.String({ description: "One sentence, in your own words." }),
        category: Type.Optional(
          Type.Union(USER_CATEGORIES.map((c) => Type.Literal(c)), {
            description: "facts, preferences, interests, or behaviors. Defaults to facts.",
          }),
        ),
      }),
      async execute(_id: string, p: any) {
        const said = await rememberUser(String(p.fact ?? ""), p.category ?? "facts");
        return { content: [{ type: "text" as const, text: said }], details: {} };
      },
    });
  };
}
