import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  findByZaloUserId,
  setSubscriptionStatus,
  type Customer,
} from '../db/customers.js';
import { claimProcessedMessage } from '../db/processed.js';
import type { NormalizedInbound, ZaloAdapter } from '../zalo/types.js';
import { getOrCreateTopic, markTopicMissing } from './mapper.js';
import { isRegisterIntent, isUnsubscribeIntent } from './registration.js';

/**
 * Luồng A: Zalo → Telegram topic
 *
 * Topic chỉ được tạo khi:
 * - Khách nhắn /register hoặc "đăng ký"
 * - Admin /useradd (không đi qua đây)
 *
 * Tin thường từ người chưa có topic → không tạo topic, chỉ gợi ý đăng ký trên Zalo.
 */
export function wireInbound(api: Api, adapter: ZaloAdapter): void {
  adapter.onInbound(async (msg) => {
    try {
      await handleInbound(api, adapter, msg);
    } catch (err) {
      logger.error({ err, zaloUserId: msg.zaloUserId }, 'Inbound Zalo→Tele failed');
    }
  });
}

async function handleInbound(
  api: Api,
  adapter: ZaloAdapter,
  msg: NormalizedInbound,
): Promise<void> {
  if (msg.messageId) {
    const claimed = claimProcessedMessage(adapter.mode, msg.messageId);
    if (!claimed) {
      logger.info(
        { messageId: msg.messageId, provider: adapter.mode },
        'Skip duplicate inbound message',
      );
      return;
    }
  }

  const existing = findByZaloUserId(msg.zaloUserId, adapter.mode);
  const text = (msg.text ?? '').trim();

  // --- Đăng ký: mới được tạo topic ---
  if (!msg.unsupportedKind && text && isRegisterIntent(text)) {
    const customer = await getOrCreateTopic(
      api,
      msg.zaloUserId,
      adapter.mode,
      msg.displayName,
    );

    if (customer.subscriptionStatus === 'approved') {
      await sendToTopicSafe(api, customer, `ℹ️ Khách đã approved — nhắc đăng ký lại.`);
      try {
        await adapter.sendText(msg.zaloUserId, 'Bạn đã được duyệt và đang nhận tin.');
      } catch {
        // ignore
      }
      return;
    }

    if (!customer.blocked) {
      setSubscriptionStatus(msg.zaloUserId, adapter.mode, 'pending');
    }

    await sendToTopicSafe(
      api,
      { ...customer, subscriptionStatus: customer.blocked ? customer.subscriptionStatus : 'pending' },
      [
        `📝 Yêu cầu đăng ký từ ${customer.displayName ?? customer.zaloUserId}`,
        `zalo=${customer.zaloUserId}`,
        customer.blocked
          ? '⚠️ Khách đang bị block — /unblock rồi /approve'
          : 'Dùng /approve hoặc /reject trong topic này.',
      ].join('\n'),
    );

    try {
      await adapter.sendText(
        msg.zaloUserId,
        customer.blocked
          ? 'Tài khoản đang bị chặn. Vui lòng liên hệ quản trị.'
          : 'Đã nhận yêu cầu đăng ký. Vui lòng chờ quản trị viên duyệt.',
      );
    } catch (err) {
      logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to ack register on Zalo');
    }
    return;
  }

  // --- Chưa có topic: không tạo, chỉ gợi ý đăng ký ---
  if (!existing) {
    logger.info(
      { zaloUserId: msg.zaloUserId, unsupportedKind: msg.unsupportedKind },
      'Inbound from unknown Zalo user — skip topic create',
    );
    if (!msg.unsupportedKind && text && !isUnsubscribeIntent(text)) {
      try {
        await adapter.sendText(
          msg.zaloUserId,
          'Xin chào! Nhắn "đăng ký" hoặc /register để được xét duyệt nhận tin.',
        );
      } catch (err) {
        logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to hint register on Zalo');
      }
    }
    return;
  }

  // Có thể topic bị xóa → getOrCreateTopic sẽ recreate nếu topic_missing
  const customer = await getOrCreateTopic(
    api,
    msg.zaloUserId,
    adapter.mode,
    msg.displayName,
  );

  if (msg.unsupportedKind) {
    await sendToTopicSafe(
      api,
      customer,
      `[Chưa hỗ trợ] Khách gửi ${msg.unsupportedKind}` +
        (msg.messageId ? ` (msg ${msg.messageId})` : ''),
    );
    return;
  }

  if (!text) return;

  if (isUnsubscribeIntent(text)) {
    setSubscriptionStatus(msg.zaloUserId, adapter.mode, 'unsubscribed');
    await sendToTopicSafe(
      api,
      customer,
      `⛔ Khách hủy đăng ký: ${customer.displayName ?? customer.zaloUserId}`,
    );
    try {
      await adapter.sendText(
        msg.zaloUserId,
        'Bạn đã hủy đăng ký nhận tin. Nhắn "đăng ký" hoặc /register nếu muốn đăng ký lại.',
      );
    } catch (err) {
      logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to ack unsubscribe on Zalo');
    }
    return;
  }

  const prefix =
    customer.subscriptionStatus !== 'approved'
      ? `[${customer.subscriptionStatus}] `
      : customer.blocked
        ? `[blocked] `
        : '';

  await sendToTopicSafe(api, customer, `${prefix}${text}`);
}

async function sendToTopicSafe(api: Api, customer: Customer, text: string): Promise<void> {
  const env = getEnv();
  try {
    await api.sendMessage(env.telegramForumGroupId, text, {
      message_thread_id: customer.telegramTopicId,
    });
    logger.info(
      { zaloUserId: customer.zaloUserId, topicId: customer.telegramTopicId },
      'Forwarded Zalo → Telegram topic',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/thread not found|message thread not found|TOPIC_DELETED|chat not found/i.test(message)) {
      markTopicMissing(customer);
      logger.warn(
        { zaloUserId: customer.zaloUserId, topicId: customer.telegramTopicId },
        'Topic missing — marked for recreate',
      );
    }
    throw err;
  }
}
