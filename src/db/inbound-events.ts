import { getDb } from './client.js';
import type { ZaloMode } from '../zalo/types.js';

/**
 * Persist inbound webhook/event before ack.
 * @returns true if newly stored; false if duplicate.
 */
export function storeInboundEvent(
  provider: ZaloMode,
  messageId: string,
  payload: unknown,
): boolean {
  const now = new Date().toISOString();
  try {
    getDb()
      .prepare(
        `INSERT INTO inbound_events (provider, message_id, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(provider, messageId, JSON.stringify(payload), now, now);
    return true;
  } catch {
    return false;
  }
}

export function markInboundEventDone(provider: ZaloMode, messageId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE inbound_events SET status = 'done', updated_at = ?
       WHERE provider = ? AND message_id = ?`,
    )
    .run(now, provider, messageId);
}

export function markInboundEventFailed(
  provider: ZaloMode,
  messageId: string,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE inbound_events SET status = 'failed', updated_at = ?
       WHERE provider = ? AND message_id = ?`,
    )
    .run(now, provider, messageId);
}
