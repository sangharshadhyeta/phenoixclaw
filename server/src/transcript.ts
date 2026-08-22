import { eventsSince } from "./db.js";

export interface TranscriptChunk {
  text: string;
  /** The seq the chunk closed at — a message_end, or the last event scanned. */
  seq: number;
}

/**
 * Rebuilds a session's finished assistant messages from its stored event log.
 *
 * Same accumulation session-manager.ts's askNow() does for a live run —
 * concatenate message_update text_deltas, flush on message_end — but replayed
 * from storage instead of a live subscription, so it works for any session,
 * running or not. Used by the self-reflection routine's memory_digest tool to
 * read what a session actually said without needing pi's own transcript
 * export.
 */
export async function reconstructAssistantText(sessionId: string, sinceSeq: number): Promise<TranscriptChunk[]> {
  const rows = await eventsSince(sessionId, sinceSeq);
  const chunks: TranscriptChunk[] = [];
  let current = "";
  let lastSeq = sinceSeq;

  const flush = (seq: number) => {
    const done = current.trim();
    current = "";
    if (done) chunks.push({ text: done, seq });
  };

  for (const row of rows) {
    lastSeq = row.seq;
    let payload: any;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (row.type === "message_update") {
      const inner = payload.assistantMessageEvent ?? {};
      if (inner.type === "text_delta" && typeof inner.delta === "string") {
        current += inner.delta;
      }
    } else if (row.type === "message_end") {
      flush(row.seq);
    }
  }
  // A session still mid-run at digest time has nothing closed by a
  // message_end yet; what it has said so far still counts.
  flush(lastSeq);

  return chunks;
}
