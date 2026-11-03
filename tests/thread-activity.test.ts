import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../src/db/client.js';
import { getThreadActivityMap, touchThreadActivity } from '../src/db/thread-activity.js';
import { resetEnvCache } from '../src/config/env.js';

describe('thread_activity', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-act-'));
    process.env.DATABASE_PATH = join(dir, 't.db');
    process.env.ZALO_MODE = 'personal';
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.TELEGRAM_FORUM_GROUP_ID = '-1001';
    process.env.TELEGRAM_CHANNEL_ID = '-1002';
    process.env.TELEGRAM_ADMIN_IDS = '1';
    resetEnvCache();
    closeDb();
    getDb();
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newer timestamp on conflict', () => {
    touchThreadActivity('personal', 'g1', 'group', 1_000);
    touchThreadActivity('personal', 'g1', 'group', 500);
    touchThreadActivity('personal', 'g1', 'group', 2_000);
    const map = getThreadActivityMap('personal', 'group');
    expect(map.get('g1')).toBe(2_000);
  });
});
