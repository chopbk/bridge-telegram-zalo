import { getDb } from './client.js';

export type ThreadActivityKind = 'user' | 'group';

export function touchThreadActivity(
  provider: string,
  threadId: string,
  kind: ThreadActivityKind,
  atMs: number,
  displayName?: string,
): void {
  if (!threadId || !Number.isFinite(atMs) || atMs <= 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO thread_activity (provider, thread_id, thread_kind, last_active_at, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, thread_id) DO UPDATE SET
       last_active_at = CASE
         WHEN excluded.last_active_at > thread_activity.last_active_at
         THEN excluded.last_active_at ELSE thread_activity.last_active_at END,
       thread_kind = excluded.thread_kind,
       display_name = COALESCE(excluded.display_name, thread_activity.display_name),
       updated_at = excluded.updated_at`,
  ).run(provider, threadId, kind, Math.floor(atMs), displayName ?? null, now);
}

/** Map thread_id → last_active_at (ms) */
export function getThreadActivityMap(
  provider: string,
  kind?: ThreadActivityKind,
): Map<string, number> {
  const db = getDb();
  const rows = kind
    ? (db
        .prepare(
          `SELECT thread_id, last_active_at FROM thread_activity
           WHERE provider = ? AND thread_kind = ?`,
        )
        .all(provider, kind) as Array<{ thread_id: string; last_active_at: number }>)
    : (db
        .prepare(
          `SELECT thread_id, last_active_at FROM thread_activity WHERE provider = ?`,
        )
        .all(provider) as Array<{ thread_id: string; last_active_at: number }>);

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(String(r.thread_id), Number(r.last_active_at));
  }
  return map;
}
