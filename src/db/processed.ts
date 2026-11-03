import { getDb } from './client.js';
import type { ZaloMode } from '../zalo/types.js';

/**
 * Atomically claim a message id for processing.
 * @returns true if this caller should process; false if already seen.
 */
export function claimProcessedMessage(provider: ZaloMode, messageId: string): boolean {
  const now = new Date().toISOString();
  try {
    getDb()
      .prepare(
        `INSERT INTO processed_messages (provider, message_id, processed_at)
         VALUES (?, ?, ?)`,
      )
      .run(provider, messageId, now);
    return true;
  } catch {
    return false;
  }
}

export function wasProcessed(provider: ZaloMode, messageId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM processed_messages WHERE provider = ? AND message_id = ?`,
    )
    .get(provider, messageId) as { ok: number } | undefined;
  return Boolean(row);
}
