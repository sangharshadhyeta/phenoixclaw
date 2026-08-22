import { getDb } from "./db.js";

/**
 * Questions a colleague's conversation could not answer on its own.
 *
 * A colleague can read and explain, and nothing else. Without this the agent's
 * only honest response to anything further is "I'd have to ask" — and then
 * nobody asks. This carries the question to the primary user and the answer
 * back to the person who asked, so the refusal turns into a round trip instead
 * of a dead end.
 *
 * The id is short and typed by a human in a chat, so it is four characters and
 * only has to be unique among questions still waiting.
 */

export interface QuestionRow {
  id: string;
  session_id: string;
  person_key: string;
  person_name: string;
  /** Where the answer goes back to — the asking conversation, not the asker. */
  channel_slug: string;
  channel_key: string;
  question: string;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  /** Set when the agent is asking permission rather than an opinion. */
  action_tool: string | null;
  action: string | null;
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Unique among unanswered questions; an answered id is free to be reused. */
async function freeId(): Promise<string> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT id FROM questions WHERE answered_at IS NULL");
  const taken = new Set((reader.getRowObjectsJson() as unknown as { id: string }[]).map((r) => r.id));
  for (let attempt = 0; attempt < 500; attempt++) {
    let id = "";
    for (let i = 0; i < 4; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  throw new Error("No free question id");
}

export async function askQuestion(input: {
  sessionId: string;
  personKey: string;
  personName: string;
  channelSlug: string;
  channelKey: string;
  question: string;
  actionTool?: string | null;
  action?: string | null;
}): Promise<QuestionRow> {
  const id = await freeId();
  const conn = await getDb();
  await conn.run(
    `INSERT INTO questions
       (id, session_id, person_key, person_name, channel_slug, channel_key, question,
        action_tool, action)
     VALUES ($id, $sessionId, $personKey, $personName, $channelSlug, $channelKey, $question, $actionTool, $action)`,
    {
      id,
      sessionId: input.sessionId,
      personKey: input.personKey,
      personName: input.personName,
      channelSlug: input.channelSlug,
      channelKey: input.channelKey,
      question: input.question,
      actionTool: input.action ? (input.actionTool || "bash") : null,
      action: input.action || null,
    },
  );
  return (await getQuestion(id))!;
}

export async function getQuestion(id: string): Promise<QuestionRow | undefined> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT * FROM questions WHERE id = $id", { id });
  return reader.getRowObjectsJson()[0] as unknown as QuestionRow | undefined;
}

export async function pendingQuestions(): Promise<QuestionRow[]> {
  const conn = await getDb();
  const reader = await conn.runAndReadAll("SELECT * FROM questions WHERE answered_at IS NULL ORDER BY asked_at ASC");
  return reader.getRowObjectsJson() as unknown as QuestionRow[];
}

export async function recordAnswer(id: string, answer: string): Promise<void> {
  const conn = await getDb();
  await conn.run(
    "UPDATE questions SET answered_at = $now, answer = $answer WHERE id = $id",
    { now: new Date().toISOString(), answer, id },
  );
}

/**
 * Is this message from the primary user an answer to a waiting question?
 *
 * Matched only at the start of a message and only against an id that is
 * actually waiting, so "#tea break in 5" reaches the agent as a message rather
 * than being swallowed as an answer to something.
 */
/**
 * Approval has to be a word, not a mood.
 *
 * "sounds fine to me" is an opinion; only these grant anything. Anything else
 * is relayed as an ordinary answer and authorises nothing, so an ambiguous
 * reply can never be read as a yes.
 */
const APPROVES = /^(approve|approved|allow|allowed|yes|ok|okay|go ahead|do it|always)\b/i;

/**
 * Standing permission, which is a different promise from "yes".
 *
 * Kept to one unmistakable word: a rule that outlives the conversation should
 * never be created by a reply that merely sounded enthusiastic.
 */
const ALWAYS = /^(always)\b/i;

export async function readAnswer(
  text: string
): Promise<{ question: QuestionRow; answer: string; approves: boolean; always: boolean } | null> {
  const m = /^#([a-z2-9]{4})\b[\s:,-]*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const question = await getQuestion(m[1].toLowerCase());
  if (!question || question.answered_at) return null;
  const answer = m[2].trim();
  if (!answer) return null;
  return { question, answer, approves: APPROVES.test(answer), always: ALWAYS.test(answer) };
}
