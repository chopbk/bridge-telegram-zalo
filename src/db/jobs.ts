import { getDb } from './client.js';
import { getEnv } from '../config/env.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type JobType = 'broadcast' | 'broadcast_item';

export type JobRow = {
  id: number;
  type: JobType;
  parent_id: number | null;
  status: JobStatus;
  payload: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
};

export type BroadcastPayload = {
  text: string;
  provider: string;
  channelMessageId?: number;
};

export type BroadcastItemPayload = {
  text: string;
  provider: string;
  zaloUserId: string;
  displayName?: string | null;
  threadKind?: 'user' | 'group';
};

export type Job = {
  id: number;
  type: JobType;
  parentId: number | null;
  status: JobStatus;
  payload: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
};

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    parentId: row.parent_id,
    status: row.status,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
  };
}

export function createBroadcastJob(input: {
  text: string;
  provider: string;
  channelMessageId?: number;
  targets: Array<{
    zaloUserId: string;
    displayName?: string | null;
    threadKind?: 'user' | 'group';
  }>;
}): { parentId: number; itemIds: number[] } {
  const db = getDb();
  const now = new Date().toISOString();
  const maxAttempts = getEnv().JOB_MAX_RETRIES;

  const parentPayload: BroadcastPayload = {
    text: input.text,
    provider: input.provider,
    channelMessageId: input.channelMessageId,
  };

  db.exec('BEGIN');
  try {
    const parentResult = db
      .prepare(
        `INSERT INTO jobs
          (type, parent_id, status, payload, attempts, max_attempts, last_error, created_at, updated_at, next_run_at)
         VALUES ('broadcast', NULL, 'running', ?, 0, ?, NULL, ?, ?, ?)`,
      )
      .run(JSON.stringify(parentPayload), maxAttempts, now, now, now) as {
      lastInsertRowid: number | bigint;
    };

    const parentId = Number(parentResult.lastInsertRowid);
    const itemIds: number[] = [];

    const insertItem = db.prepare(
      `INSERT INTO jobs
        (type, parent_id, status, payload, attempts, max_attempts, last_error, created_at, updated_at, next_run_at)
       VALUES ('broadcast_item', ?, 'pending', ?, 0, ?, NULL, ?, ?, ?)`,
    );

    for (const t of input.targets) {
      const itemPayload: BroadcastItemPayload = {
        text: input.text,
        provider: input.provider,
        zaloUserId: t.zaloUserId,
        displayName: t.displayName ?? null,
        threadKind: t.threadKind ?? 'user',
      };
      const r = insertItem.run(
        parentId,
        JSON.stringify(itemPayload),
        maxAttempts,
        now,
        now,
        now,
      ) as { lastInsertRowid: number | bigint };
      itemIds.push(Number(r.lastInsertRowid));
    }

    db.exec('COMMIT');
    return { parentId, itemIds };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function claimNextBroadcastItem(parentId?: number): Job | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const row =
      parentId != null
        ? (db
            .prepare(
              `SELECT * FROM jobs
               WHERE type = 'broadcast_item'
                 AND parent_id = ?
                 AND status = 'pending'
                 AND (next_run_at IS NULL OR next_run_at <= ?)
               ORDER BY id ASC
               LIMIT 1`,
            )
            .get(parentId, now) as JobRow | undefined)
        : (db
            .prepare(
              `SELECT * FROM jobs
               WHERE type = 'broadcast_item'
                 AND status = 'pending'
                 AND (next_run_at IS NULL OR next_run_at <= ?)
               ORDER BY id ASC
               LIMIT 1`,
            )
            .get(now) as JobRow | undefined);

    if (!row) {
      db.exec('COMMIT');
      return null;
    }

    db.prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    ).run(now, row.id);

    const updated = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(row.id) as JobRow;
    db.exec('COMMIT');
    return mapJob(updated);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markJobDone(id: number): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE jobs SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?`)
    .run(now, id);
}

export function markJobFailedOrRetry(id: number, error: string): 'retry' | 'failed' {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  if (!row) return 'failed';

  const now = new Date().toISOString();
  if (row.attempts < row.max_attempts) {
    const backoffMs = Math.min(60_000, 1000 * 2 ** Math.max(0, row.attempts - 1));
    const next = new Date(Date.now() + backoffMs).toISOString();
    db.prepare(
      `UPDATE jobs SET status = 'pending', last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    ).run(error.slice(0, 500), next, now, id);
    return 'retry';
  }

  db.prepare(
    `UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(error.slice(0, 500), now, id);
  return 'failed';
}

export function finalizeBroadcastParent(parentId: number): {
  ok: number;
  fail: number;
  failedUserIds: string[];
} {
  const db = getDb();
  const children = db
    .prepare(`SELECT * FROM jobs WHERE parent_id = ?`)
    .all(parentId) as JobRow[];

  let ok = 0;
  let fail = 0;
  const failedUserIds: string[] = [];

  for (const child of children) {
    if (child.status === 'done') ok += 1;
    else if (child.status === 'failed') {
      fail += 1;
      try {
        const payload = JSON.parse(child.payload) as BroadcastItemPayload;
        failedUserIds.push(payload.zaloUserId);
      } catch {
        // ignore
      }
    }
  }

  const pendingLeft = children.some(
    (c) => c.status === 'pending' || c.status === 'running',
  );
  if (!pendingLeft) {
    const now = new Date().toISOString();
    const status: JobStatus = fail > 0 && ok === 0 ? 'failed' : 'done';
    db.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`).run(
      status,
      now,
      parentId,
    );
  }

  return { ok, fail, failedUserIds };
}

export function getJob(id: number): Job | null {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | JobRow
    | undefined;
  return row ? mapJob(row) : null;
}

export function listFailedBroadcastItems(parentId: number): Job[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM jobs WHERE parent_id = ? AND type = 'broadcast_item' AND status = 'failed'`,
    )
    .all(parentId) as JobRow[];
  return rows.map(mapJob);
}

export function requeueFailedBroadcastItems(parentId: number): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'pending', attempts = 0, last_error = NULL, next_run_at = ?, updated_at = ?
       WHERE parent_id = ? AND type = 'broadcast_item' AND status = 'failed'`,
    )
    .run(now, now, parentId) as { changes: number };

  db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?`).run(
    now,
    parentId,
  );
  return result.changes;
}

export function countPendingBroadcastItems(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE type = 'broadcast_item' AND status IN ('pending', 'running')`,
    )
    .get() as { n: number };
  return row.n;
}

/** Reset stuck running items after restart so they can be retried. */
export function recoverStuckJobs(): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE jobs
       SET status = 'pending', next_run_at = ?, updated_at = ?
       WHERE status = 'running' AND type = 'broadcast_item'`,
    )
    .run(now, now) as { changes: number };
  return result.changes;
}

/** Milliseconds until the next pending item is runnable; null if none pending. */
export function msUntilNextPendingItem(parentId?: number): number | null {
  const row =
    parentId != null
      ? (getDb()
          .prepare(
            `SELECT next_run_at FROM jobs
             WHERE type = 'broadcast_item' AND parent_id = ? AND status = 'pending'
             ORDER BY next_run_at ASC LIMIT 1`,
          )
          .get(parentId) as { next_run_at: string | null } | undefined)
      : (getDb()
          .prepare(
            `SELECT next_run_at FROM jobs
             WHERE type = 'broadcast_item' AND status = 'pending'
             ORDER BY next_run_at ASC LIMIT 1`,
          )
          .get() as { next_run_at: string | null } | undefined);

  if (!row) return null;
  if (!row.next_run_at) return 0;
  return Math.max(0, Date.parse(row.next_run_at) - Date.now());
}
