import { InputFile, type Api } from 'grammy';
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
import { downloadZaloMedia } from './media.js';
import { isRegisterIntent, isUnsubscribeIntent } from './registration.js';

/**
 * Luồng A: Zalo → Telegram topic
 *
 * - 1-1: map theo user id
 * - Group: map theo **group id** (không theo người gửi trong group)
 * Topic chỉ tạo khi register (1-1) hoặc admin /useradd.
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

function formatInboundBody(msg: NormalizedInbound, statusPrefix: string, body: string): string {
  let sender = '';
  if (msg.isSelf) {
    sender = 'Bạn: ';
  } else if (msg.threadKind === 'group' && (msg.senderName || msg.senderId)) {
    sender = `${msg.senderName || msg.senderId}: `;
  }
  return `${statusPrefix}${sender}${body}`;
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

  const isGroup = msg.threadKind === 'group';
  const existing = findByZaloUserId(msg.zaloUserId, adapter.mode);
  const text = (msg.text ?? '').trim();

  // --- Đăng ký: chỉ áp dụng 1-1, không áp cho tin của chính mình ---
  if (
    !isGroup &&
    !msg.isSelf &&
    !msg.unsupportedKind &&
    !msg.images?.length &&
    text &&
    isRegisterIntent(text)
  ) {
    const customer = await getOrCreateTopic(
      api,
      msg.zaloUserId,
      adapter.mode,
      msg.displayName,
    );

    if (customer.subscriptionStatus === 'approved') {
      await sendToTopicSafe(api, customer, `ℹ️ Khách đã approved — nhắc đăng ký lại.`);
      try {
        await adapter.sendText(msg.zaloUserId, 'Bạn đã được duyệt và đang nhận tin.', {
          threadKind: 'user',
        });
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
        { threadKind: 'user' },
      );
    } catch (err) {
      logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to ack register on Zalo');
    }
    return;
  }

  // --- Chưa có trong DB: bỏ qua, không auto-reply ---
  if (!existing) {
    logger.info(
      {
        zaloUserId: msg.zaloUserId,
        threadKind: msg.threadKind ?? 'user',
        unsupportedKind: msg.unsupportedKind,
      },
      isGroup
        ? 'Inbound from unknown Zalo group — skip'
        : 'Inbound from unknown Zalo user — skip (no auto-reply)',
    );
    return;
  }

  // Có thể topic bị xóa → getOrCreateTopic sẽ recreate nếu topic_missing
  // Không truyền senderName làm displayName (tránh đổi tên topic group thành tên member)
  const customer = await getOrCreateTopic(
    api,
    msg.zaloUserId,
    adapter.mode,
    isGroup ? undefined : msg.displayName,
  );

  const statusPrefix =
    customer.subscriptionStatus !== 'approved'
      ? `[${customer.subscriptionStatus}] `
      : customer.blocked
        ? `[blocked] `
        : '';

  if (msg.images && msg.images.length > 0) {
    const captionBody = text || (isGroup ? '(ảnh)' : '');
    const caption = formatInboundBody(msg, statusPrefix, captionBody).trim() || undefined;
    await sendPhotosToTopicSafe(api, customer, msg.images.map((i) => i.url), caption);
    return;
  }

  if (msg.unsupportedKind) {
    await sendToTopicSafe(
      api,
      customer,
      formatInboundBody(
        msg,
        statusPrefix,
        `[Chưa hỗ trợ] ${msg.unsupportedKind}` +
          (msg.messageId ? ` (msg ${msg.messageId})` : ''),
      ),
    );
    return;
  }

  if (!text) return;

  // Hủy đăng ký: chỉ 1-1, không áp cho tin của chính mình
  if (!isGroup && !msg.isSelf && isUnsubscribeIntent(text)) {
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
        { threadKind: 'user' },
      );
    } catch (err) {
      logger.warn({ err, zaloUserId: msg.zaloUserId }, 'Failed to ack unsubscribe on Zalo');
    }
    return;
  }

  await sendToTopicSafe(api, customer, formatInboundBody(msg, statusPrefix, text));
}

async function sendToTopicSafe(api: Api, customer: Customer, text: string): Promise<void> {
  const env = getEnv();
  try {
    await api.sendMessage(env.telegramForumGroupId, text, {
      message_thread_id: customer.telegramTopicId,
    });
    logger.info(
      {
        zaloUserId: customer.zaloUserId,
        topicId: customer.telegramTopicId,
        threadKind: customer.threadKind,
      },
      'Forwarded Zalo → Telegram topic',
    );
  } catch (err) {
    handleTopicSendError(err, customer);
    throw err;
  }
}

async function sendPhotosToTopicSafe(
  api: Api,
  customer: Customer,
  urls: string[],
  caption?: string,
): Promise<void> {
  const env = getEnv();
  const chatId = env.telegramForumGroupId;
  const threadId = customer.telegramTopicId;

  try {
    const buffers: Buffer[] = [];
    const failedUrls: string[] = [];
    for (const url of urls) {
      try {
        buffers.push(await downloadZaloMedia(url));
      } catch (err) {
        logger.warn({ err, url: url.slice(0, 100) }, 'Zalo photo download failed');
        failedUrls.push(url);
      }
    }

    if (buffers.length === 0) {
      await api.sendMessage(
        chatId,
        [
          caption ? `${caption}\n` : '',
          '[Ảnh] Không tải được file từ Zalo — gửi link:',
          ...failedUrls.map((u) => u.slice(0, 200)),
        ].join('\n'),
        { message_thread_id: threadId },
      );
      return;
    }

    if (buffers.length === 1) {
      await api.sendPhoto(chatId, new InputFile(buffers[0]!, 'zalo-photo.jpg'), {
        message_thread_id: threadId,
        caption: caption || undefined,
      });
    } else {
      const media = buffers.map((buf, i) => ({
        type: 'photo' as const,
        media: new InputFile(buf, `zalo-photo-${i + 1}.jpg`),
        ...(i === 0 && caption ? { caption } : {}),
      }));
      await api.sendMediaGroup(chatId, media, {
        message_thread_id: threadId,
      });
    }

    if (failedUrls.length > 0) {
      await api.sendMessage(
        chatId,
        `[Ảnh] ${failedUrls.length} file không tải được`,
        { message_thread_id: threadId },
      );
    }

    logger.info(
      {
        zaloUserId: customer.zaloUserId,
        topicId: threadId,
        photoCount: buffers.length,
        failed: failedUrls.length,
      },
      'Forwarded Zalo photo(s) → Telegram topic',
    );
  } catch (err) {
    handleTopicSendError(err, customer);
    throw err;
  }
}

function handleTopicSendError(err: unknown, customer: Customer): void {
  const message = err instanceof Error ? err.message : String(err);
  if (/thread not found|message thread not found|TOPIC_DELETED|chat not found/i.test(message)) {
    markTopicMissing(customer);
    logger.warn(
      { zaloUserId: customer.zaloUserId, topicId: customer.telegramTopicId },
      'Topic missing — marked for recreate',
    );
  }
}
