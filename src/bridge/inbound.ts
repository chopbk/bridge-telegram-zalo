import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  setSubscriptionStatus,
  type Customer,
} from '../db/customers.js';
import { claimProcessedMessage } from '../db/processed.js';
import type { NormalizedInbound, ZaloAdapter } from '../zalo/types.js';
import { getOrCreateTopic, markTopicMissing } from './mapper.js';
import { isRegisterIntent, isUnsubscribeIntent } from './registration.js';

/**
 * Luồng A: Zalo → Telegram topic (+ đăng ký / hủy đăng ký)
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

  const text = msg.text.trim();
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
        'Bạn đã hủy đăng ký nhận tin. Nhắn "đăng ký" nếu muốn đăng ký lại.',
      );
    } catch (err) {
      logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to ack unsubscribe on Zalo');
    }
    return;
  }

  if (isRegisterIntent(text)) {
    if (customer.subscriptionStatus === 'approved') {
      await sendToTopicSafe(api, customer, `ℹ️ Khách đã approved — nhắc đăng ký lại.`);
      try {
        await adapter.sendText(msg.zaloUserId, 'Bạn đã được duyệt và đang nhận tin.');
      } catch {
        // ignore
      }
      return;
    }

    if (
      customer.subscriptionStatus === 'rejected' ||
      customer.subscriptionStatus === 'unsubscribed' ||
      customer.subscriptionStatus === 'pending'
    ) {
      // Re-request → pending again (unless blocked)
      if (!customer.blocked) {
        setSubscriptionStatus(msg.zaloUserId, adapter.mode, 'pending');
      }
    }

    await sendToTopicSafe(
      api,
      customer,
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

  // Normal message — always forward to topic for admin visibility
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
