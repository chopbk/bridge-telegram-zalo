import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  claimNextBroadcastItem,
  createBroadcastJob,
  finalizeBroadcastParent,
  markJobDone,
  markJobFailedOrRetry,
  recoverStuckJobs,
  requeueFailedBroadcastItems,
} from '../src/db/jobs.js';

describe('broadcast jobs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-jobs-'));
    process.env.ZALO_MODE = 'personal';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.TELEGRAM_FORUM_GROUP_ID = '-1001';
    process.env.TELEGRAM_CHANNEL_ID = '-1002';
    process.env.TELEGRAM_ADMIN_IDS = '111';
    process.env.JOB_MAX_RETRIES = '2';
    process.env.DATABASE_PATH = join(dir, 'test.db');
    resetEnvCache();
    closeDb();
    getDb();
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent + items and drains to done', () => {
    const { parentId, itemIds } = createBroadcastJob({
      text: 'hello',
      provider: 'personal',
      targets: [{ zaloUserId: 'a' }, { zaloUserId: 'b' }],
    });
    expect(itemIds).toHaveLength(2);

    const first = claimNextBroadcastItem(parentId);
    expect(first?.parentId).toBe(parentId);
    markJobDone(first!.id);

    const second = claimNextBroadcastItem(parentId);
    markJobDone(second!.id);

    expect(claimNextBroadcastItem(parentId)).toBeNull();
    const summary = finalizeBroadcastParent(parentId);
    expect(summary.ok).toBe(2);
    expect(summary.fail).toBe(0);
  });

  it('retries then fails with limit', () => {
    const { parentId } = createBroadcastJob({
      text: 'x',
      provider: 'personal',
      targets: [{ zaloUserId: 'only' }],
    });

    const job1 = claimNextBroadcastItem(parentId)!;
    expect(markJobFailedOrRetry(job1.id, 'err1')).toBe('retry');

    // Force next_run_at to now
    getDb()
      .prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), job1.id);

    const job2 = claimNextBroadcastItem(parentId)!;
    expect(job2.id).toBe(job1.id);
    expect(markJobFailedOrRetry(job2.id, 'err2')).toBe('failed');

    const summary = finalizeBroadcastParent(parentId);
    expect(summary.fail).toBe(1);
    expect(summary.failedUserIds).toContain('only');
  });

  it('recovers stuck running jobs and requeues failed', () => {
    const { parentId } = createBroadcastJob({
      text: 'y',
      provider: 'personal',
      targets: [{ zaloUserId: 'z' }],
    });
    const job = claimNextBroadcastItem(parentId)!;
    expect(job.status).toBe('running');

    expect(recoverStuckJobs()).toBe(1);
    const again = claimNextBroadcastItem(parentId);
    expect(again?.id).toBe(job.id);

    // attempts already at max (2) after reclaim → permanent fail
    expect(markJobFailedOrRetry(again!.id, 'e1')).toBe('failed');

    expect(requeueFailedBroadcastItems(parentId)).toBe(1);
    expect(claimNextBroadcastItem(parentId)?.id).toBe(again!.id);
  });
});
