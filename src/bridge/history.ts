import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import type { Customer } from '../db/customers.js';
import { claimProcessedMessage } from '../db/processed.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { forwardKnownCustomerInbound } from './inbound.js';

export const GROUP_HISTORY_DEFAULT_LIMIT = 50;
const SEND_GAP_MS = 300;

export type BackfillResult = {
  loaded: number;
  skipped: number;
  failed: number;
  total: number;
};

/**
 * Sau /useradd group: nạp N tin gần nhất từ Zalo vào topic (cũ → mới).
 */
export async function backfillGroupHistory(
  api: Api,
  adapter: ZaloAdapter,
  customer: Customer,
  limit = GROUP_HISTORY_DEFAULT_LIMIT,
): Promise<BackfillResult> {
  if (customer.threadKind !== 'group') {
    return { loaded: 0, skipped: 0, failed: 0, total: 0 };
  }
  if (!adapter.fetchGroupHistory) {
    throw new Error('Adapter hiện tại không hỗ trợ lấy lịch sử group');
  }

  const env = getEnv();
  const chatId = env.telegramForumGroupId;
  const topicId = customer.telegramTopicId;

  await api
    .sendMessage(
      chatId,
      `📜 Đang nạp tối đa ${limit} tin gần nhất từ group Zalo…`,
      { message_thread_id: topicId },
    )
    .catch(() => undefined);

  let msgs;
  try {
    msgs = await adapter.fetchGroupHistory(customer.zaloUserId, limit);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await api
      .sendMessage(chatId, `⚠️ Không lấy được lịch sử Zalo: ${detail}`, {
        message_thread_id: topicId,
      })
      .catch(() => undefined);
    throw err;
  }

  let loaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const msg of msgs) {
    // Gắn đúng thread id (history đôi khi thiếu / lệch)
    const normalized = { ...msg, zaloUserId: customer.zaloUserId, threadKind: 'group' as const };

    if (normalized.messageId) {
      const claimed = claimProcessedMessage(adapter.mode, normalized.messageId);
      if (!claimed) {
        skipped += 1;
        continue;
      }
    }

    try {
      await forwardKnownCustomerInbound(api, adapter, customer, normalized);
      loaded += 1;
      await sleep(SEND_GAP_MS);
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, messageId: normalized.messageId, topicId },
        'Failed to backfill one history message',
      );
    }
  }

  await api
    .sendMessage(
      chatId,
      `✅ Đã nạp lịch sử: ${loaded}/${msgs.length}` +
        (skipped ? `, bỏ trùng ${skipped}` : '') +
        (failed ? `, lỗi ${failed}` : ''),
      { message_thread_id: topicId },
    )
    .catch(() => undefined);

  logger.info(
    {
      groupId: customer.zaloUserId,
      topicId,
      loaded,
      skipped,
      failed,
      total: msgs.length,
    },
    'Group history backfill done',
  );

  return { loaded, skipped, failed, total: msgs.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
