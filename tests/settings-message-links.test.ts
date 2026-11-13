import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  findMessageLinkByTelegram,
  findMessageLinkByZalo,
  setZaloCliMsgId,
  upsertMessageLink,
} from '../src/db/message-links.js';
import {
  appendSignaturePlain,
  getSignatureConfig,
  setSignatureEnabled,
  setSignatureText,
} from '../src/db/settings.js';

function setupEnv(dir: string): void {
  process.env.ZALO_MODE = 'personal';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.TELEGRAM_FORUM_GROUP_ID = '-1001';
  process.env.TELEGRAM_CHANNEL_ID = '-1002';
  process.env.TELEGRAM_ADMIN_IDS = '111';
  process.env.DATABASE_PATH = join(dir, 'test.db');
  delete process.env.FORWARD_SIGNATURE;
  resetEnvCache();
  closeDb();
  getDb();
}

describe('signature settings', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-sig-'));
    setupEnv(dir);
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults off without env or db', () => {
    expect(getSignatureConfig().enabled).toBe(false);
    expect(appendSignaturePlain('hello')).toBe('hello');
  });

  it('set text enables signature', () => {
    setSignatureText('bridge');
    expect(getSignatureConfig()).toEqual({ enabled: true, text: 'bridge' });
    expect(appendSignaturePlain('hello')).toBe('hello\n\n— bridge');
  });

  it('can disable while keeping stored text', () => {
    setSignatureText('sig');
    setSignatureEnabled(false);
    const cfg = getSignatureConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.text).toBe('sig');
    expect(appendSignaturePlain('hi')).toBe('hi');
  });

  it('uses FORWARD_SIGNATURE env when db empty', () => {
    closeDb();
    process.env.FORWARD_SIGNATURE = 'from-env';
    resetEnvCache();
    getDb();
    expect(getSignatureConfig()).toEqual({ enabled: true, text: 'from-env' });
  });
});

describe('message links', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-zalo-ml-'));
    setupEnv(dir);
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts and finds by zalo / telegram', () => {
    upsertMessageLink({
      provider: 'personal',
      direction: 'z2t',
      zaloMsgId: 'z1',
      zaloCliMsgId: 'c1',
      zaloThreadId: 'u1',
      threadKind: 'user',
      telegramChatId: -1001,
      telegramMessageId: 10,
      telegramTopicId: 3,
      bodyText: 'hi',
    });
    expect(findMessageLinkByZalo('personal', 'z1')?.telegramMessageId).toBe(10);
    expect(findMessageLinkByTelegram('personal', -1001, 10)?.zaloMsgId).toBe('z1');
  });

  it('enriches cliMsgId later', () => {
    upsertMessageLink({
      provider: 'personal',
      direction: 't2z',
      zaloMsgId: 'z2',
      zaloThreadId: 'u2',
      threadKind: 'user',
      telegramChatId: -1001,
      telegramMessageId: 20,
      telegramTopicId: 4,
    });
    setZaloCliMsgId('personal', 'z2', 'cli-9');
    expect(findMessageLinkByZalo('personal', 'z2')?.zaloCliMsgId).toBe('cli-9');
  });
});
