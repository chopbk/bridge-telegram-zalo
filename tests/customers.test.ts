import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  findByTopicId,
  insertCustomer,
  listBroadcastTargets,
  setMuted,
} from '../src/db/customers.js';

describe('customers db', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-'));
    process.env.ZALO_MODE = 'bot';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.TELEGRAM_FORUM_GROUP_ID = '-1001';
    process.env.TELEGRAM_CHANNEL_ID = '-1002';
    process.env.ZALO_BOT_TOKEN = 'zbot';
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

  it('inserts and finds by topic', () => {
    const c = insertCustomer({
      zaloUserId: 'u1',
      telegramTopicId: 42,
      provider: 'bot',
      displayName: 'Test',
    });
    expect(c.zaloUserId).toBe('u1');
    expect(findByTopicId(42)?.displayName).toBe('Test');
  });

  it('mute removes from broadcast targets', () => {
    insertCustomer({
      zaloUserId: 'u2',
      telegramTopicId: 7,
      provider: 'personal',
    });
    expect(listBroadcastTargets()).toHaveLength(1);
    setMuted('u2', true);
    expect(listBroadcastTargets()).toHaveLength(0);
  });
});
