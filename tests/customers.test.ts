import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  deleteCustomer,
  findByTopicId,
  findByZaloUserId,
  insertCustomer,
  listBroadcastTargets,
  listCustomersPage,
  searchCustomers,
  setMuted,
  setSubscriptionStatus,
  updateCustomer,
} from '../src/db/customers.js';
import { claimProcessedMessage } from '../src/db/processed.js';

function setupEnv(dir: string): void {
  process.env.ZALO_MODE = 'personal';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_FORUM_GROUP_ID = '-1001';
  process.env.TELEGRAM_CHANNEL_ID = '-1002';
  process.env.TELEGRAM_ADMIN_IDS = '111';
  process.env.DATABASE_PATH = join(dir, 'test.db');
  resetEnvCache();
  closeDb();
  getDb();
}

describe('customers db', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-'));
    setupEnv(dir);
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts pending and finds by topic', () => {
    const c = insertCustomer({
      zaloUserId: 'u1',
      telegramTopicId: 42,
      provider: 'personal',
      displayName: 'Test',
    });
    expect(c.zaloUserId).toBe('u1');
    expect(c.subscriptionStatus).toBe('pending');
    expect(findByTopicId(42, 'personal')?.displayName).toBe('Test');
  });

  it('pending customers are not broadcast targets', () => {
    insertCustomer({
      zaloUserId: 'u2',
      telegramTopicId: 7,
      provider: 'personal',
    });
    expect(listBroadcastTargets('personal')).toHaveLength(0);
  });

  it('approved unmuted customers are broadcast targets; mute removes them', () => {
    insertCustomer({
      zaloUserId: 'u3',
      telegramTopicId: 8,
      provider: 'personal',
      subscriptionStatus: 'approved',
    });
    expect(listBroadcastTargets('personal')).toHaveLength(1);
    setMuted('u3', 'personal', true);
    expect(listBroadcastTargets('personal')).toHaveLength(0);
  });

  it('unsubscribe removes from broadcast even if not muted', () => {
    insertCustomer({
      zaloUserId: 'u4',
      telegramTopicId: 9,
      provider: 'personal',
      subscriptionStatus: 'approved',
    });
    setSubscriptionStatus('u4', 'personal', 'unsubscribed');
    expect(listBroadcastTargets('personal')).toHaveLength(0);
  });

  it('scopes customers by provider', () => {
    insertCustomer({
      zaloUserId: 'same',
      telegramTopicId: 1,
      provider: 'personal',
      subscriptionStatus: 'approved',
    });
    insertCustomer({
      zaloUserId: 'same',
      telegramTopicId: 2,
      provider: 'bot',
      subscriptionStatus: 'approved',
    });
    expect(listBroadcastTargets('personal')).toHaveLength(1);
    expect(listBroadcastTargets('bot')).toHaveLength(1);
  });

  it('paginates and searches', () => {
    for (let i = 0; i < 5; i++) {
      insertCustomer({
        zaloUserId: `u${i}`,
        telegramTopicId: 100 + i,
        provider: 'personal',
        displayName: i === 2 ? 'Alice Nguyen' : `User ${i}`,
      });
    }
    const page1 = listCustomersPage({
      provider: 'personal',
      page: 1,
      pageSize: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const found = searchCustomers('personal', 'Alice');
    expect(found).toHaveLength(1);
    expect(found[0]?.displayName).toBe('Alice Nguyen');
  });

  it('dedups processed messages', () => {
    expect(claimProcessedMessage('personal', 'm1')).toBe(true);
    expect(claimProcessedMessage('personal', 'm1')).toBe(false);
    expect(claimProcessedMessage('bot', 'm1')).toBe(true);
  });

  it('updates and deletes customers', () => {
    insertCustomer({
      zaloUserId: 'u-del',
      telegramTopicId: 55,
      provider: 'personal',
      displayName: 'Old',
      subscriptionStatus: 'pending',
    });

    const updated = updateCustomer('u-del', 'personal', {
      displayName: 'New Name',
      subscriptionStatus: 'approved',
      muted: true,
      blocked: false,
    });
    expect(updated?.displayName).toBe('New Name');
    expect(updated?.subscriptionStatus).toBe('approved');
    expect(updated?.muted).toBe(true);
    expect(listBroadcastTargets('personal')).toHaveLength(0); // muted

    const removed = deleteCustomer('u-del', 'personal');
    expect(removed?.zaloUserId).toBe('u-del');
    expect(findByZaloUserId('u-del', 'personal')).toBeNull();
    expect(deleteCustomer('u-del', 'personal')).toBeNull();
  });

  it('stores thread kind for groups', () => {
    const c = insertCustomer({
      zaloUserId: 'g1',
      telegramTopicId: 99,
      provider: 'personal',
      displayName: 'Group A',
      subscriptionStatus: 'approved',
      threadKind: 'group',
    });
    expect(c.threadKind).toBe('group');
    const patched = updateCustomer('g1', 'personal', { threadKind: 'user' });
    expect(patched?.threadKind).toBe('user');
  });
});
