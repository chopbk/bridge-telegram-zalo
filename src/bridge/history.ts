import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import type { Customer } from '../db/customers.js';
import { findMessageLinkByZalo } from '../db/message-links.js';
import { claimProcessedMessage } from '../db/processed.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { forwardKnownCustomerInbound } from './inbound.js';

export const GROUP_HISTORY_DEFAULT_LIMIT = 50;
/** Lấy dư để bỏ qua tin đã forward thật rồi vẫn còn tin cũ hơn */
const FETCH_MULTIPLIER = 3;
const SEND_GAP_MS = 350;

export type BackfillResult = {
  loaded: number;
  skipped: number;
  failed: number;
  total: number;
  emptyHint?: string;
};

/**
 * Sau /useradd group hoặc /history: nạp N tin gần nhất từ Zalo vào topic (cũ → mới).
 *
 * Chỉ coi là "trùng" khi đã có trong message_links (đã gửi lên Telegram thật).
 * Không dùng processed_messages để skip — bảng đó có thể bị claim dù gửi topic thất bại.
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

  let fetchResult;
  try {
    fetchResult = await adapter.fetchGroupHistory(
      customer.zaloUserId,
      Math.min(200, limit * FETCH_MULTIPLIER),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await api
      .sendMessage(chatId, `⚠️ Không lấy được lịch sử Zalo: ${detail}`, {
        message_thread_id: topicId,
      })
      .catch(() => undefined);
    throw err;
  }

  const msgs = fetchResult.messages;
  const meta = fetchResult.meta;

  if (msgs.length === 0) {
    const hint = meta.isFiltered
      ? 'Zalo đang lọc lịch sử group này với session hiện tại (isFiltered). Thử mở group trên Zalo PC/Web rồi /history lại.'
      : 'Zalo Cloud + Media Store đều trống (group chưa sync tin lên cloud / kho media). Mở group trên Zalo PC/Web một lần rồi /history lại — tin text cũ có thể vẫn không lấy được nếu Zalo chưa đẩy lên cloud.';
    await api
      .sendMessage(chatId, `⚠️ ${hint}`, { message_thread_id: topicId })
      .catch(() => undefined);
    logger.warn(
      { groupId: customer.zaloUserId, topicId, meta },
      'Group history empty from Zalo cloud + media store',
    );
    return {
      loaded: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      emptyHint: hint,
    };
  }

  let loaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const msg of msgs) {
    if (loaded >= limit) break;

    const normalized = {
      ...msg,
      zaloUserId: customer.zaloUserId,
      threadKind: 'group' as const,
    };

    // Chỉ skip khi đã forward thành công lên Telegram (có message_links)
    if (normalized.messageId) {
      const alreadyOnTelegram = findMessageLinkByZalo(
        adapter.mode,
        normalized.messageId,
      );
      if (alreadyOnTelegram) {
        skipped += 1;
        continue;
      }
    }

    try {
      await forwardKnownCustomerInbound(api, adapter, customer, normalized);
      // Claim sau khi gửi OK — chặn echo live trùng; không claim trước khi gửi
      if (normalized.messageId) {
        claimProcessedMessage(adapter.mode, normalized.messageId);
      }
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

  const sourceLabel =
    meta.source === 'media_store'
      ? 'kho media (Cloud trống — chỉ ảnh/file/link)'
      : 'cloud';
  const summary =
    loaded === 0 && skipped > 0
      ? `ℹ️ Không có tin mới: ${skipped}/${msgs.length} tin đã có trên topic này.`
      : `✅ Đã nạp lịch sử: ${loaded} tin mới` +
        (skipped ? `, đã có sẵn ${skipped}` : '') +
        (failed ? `, lỗi ${failed}` : '') +
        ` (quét ${msgs.length} tin ${sourceLabel}, ${meta.pages} trang)`;

  await api
    .sendMessage(chatId, summary, { message_thread_id: topicId })
    .catch(() => undefined);

  logger.info(
    {
      groupId: customer.zaloUserId,
      topicId,
      loaded,
      skipped,
      failed,
      total: msgs.length,
      pages: meta.pages,
      isFiltered: meta.isFiltered,
    },
    'Group history backfill done',
  );

  return { loaded, skipped, failed, total: msgs.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
