import { InputFile, type Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  findByZaloUserId,
  setSubscriptionStatus,
  type Customer,
} from '../db/customers.js';
import { upsertMessageLink } from '../db/message-links.js';
import { claimProcessedMessage } from '../db/processed.js';
import type { NormalizedInbound, ZaloAdapter } from '../zalo/types.js';
import { zaloStylesToTelegramHtml } from './format.js';
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

function inboundPrefix(msg: NormalizedInbound, statusPrefix: string): string {
  let sender = '';
  if (msg.isSelf) {
    sender = 'Bạn: ';
  } else if (msg.threadKind === 'group' && (msg.senderName || msg.senderId)) {
    sender = `${msg.senderName || msg.senderId}: `;
  }
  return `${statusPrefix}${sender}`;
}

/** HTML giữ bold/italic/… từ Zalo; prefix (Bạn:/tên) luôn plain. */
function formatInboundHtml(
  msg: NormalizedInbound,
  statusPrefix: string,
  body: string,
): string {
  const prefix = inboundPrefix(msg, statusPrefix);
  return (
    zaloStylesToTelegramHtml(prefix, []) +
    zaloStylesToTelegramHtml(body, msg.styles ?? [])
  );
}

function rememberZ2tLink(
  adapter: ZaloAdapter,
  msg: NormalizedInbound,
  customer: Customer,
  telegramMessageId: number,
  bodyText?: string,
): void {
  if (!msg.messageId || msg.messageId === 'ok') return;
  try {
    upsertMessageLink({
      provider: adapter.mode,
      direction: 'z2t',
      zaloMsgId: msg.messageId,
      zaloCliMsgId: msg.cliMsgId ?? null,
      zaloUidFrom: msg.uidFrom ?? msg.senderId ?? null,
      zaloThreadId: customer.zaloUserId,
      threadKind: customer.threadKind,
      telegramChatId: getEnv().telegramForumGroupId,
      telegramMessageId,
      telegramTopicId: customer.telegramTopicId,
      bodyText: bodyText ?? msg.text ?? null,
    });
  } catch (err) {
    logger.warn({ err, messageId: msg.messageId }, 'Failed to store z2t message link');
  }
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
    const caption =
      formatInboundHtml(msg, statusPrefix, captionBody).trim() || undefined;
    const sent = await sendPhotosToTopicSafe(
      api,
      customer,
      msg.images.map((i) => i.url),
      caption,
      Boolean(caption),
    );
    if (sent != null) {
      rememberZ2tLink(adapter, msg, customer, sent, captionBody);
    }
    return;
  }

  if (msg.unsupportedKind) {
    const sent = await sendToTopicSafe(
      api,
      customer,
      formatInboundHtml(
        msg,
        statusPrefix,
        `[Chưa hỗ trợ] ${msg.unsupportedKind}` +
          (msg.messageId ? ` (msg ${msg.messageId})` : ''),
      ),
      true,
    );
    if (sent != null) {
      rememberZ2tLink(adapter, msg, customer, sent);
    }
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

  const sent = await sendToTopicSafe(
    api,
    customer,
    formatInboundHtml(msg, statusPrefix, text),
    true,
  );
  if (sent != null) {
    rememberZ2tLink(adapter, msg, customer, sent, text);
  }
}

/** @returns telegram message_id nếu gửi thành công */
async function sendToTopicSafe(
  api: Api,
  customer: Customer,
  text: string,
  asHtml = false,
): Promise<number | null> {
  const env = getEnv();
  try {
    const sent = await api.sendMessage(env.telegramForumGroupId, text, {
      message_thread_id: customer.telegramTopicId,
      ...(asHtml ? { parse_mode: 'HTML' as const } : {}),
    });
    logger.info(
      {
        zaloUserId: customer.zaloUserId,
        topicId: customer.telegramTopicId,
        threadKind: customer.threadKind,
        telegramMessageId: sent.message_id,
      },
      'Forwarded Zalo → Telegram topic',
    );
    return sent.message_id;
  } catch (err) {
    handleTopicSendError(err, customer);
    throw err;
  }
}

/** @returns telegram message_id của ảnh đầu (để map xoá/sửa) */
async function sendPhotosToTopicSafe(
  api: Api,
  customer: Customer,
  urls: string[],
  caption?: string,
  captionAsHtml = false,
): Promise<number | null> {
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
      const sent = await api.sendMessage(
        chatId,
        [
          caption ? `${caption}\n` : '',
          '[Ảnh] Không tải được file từ Zalo — gửi link:',
          ...failedUrls.map((u) => u.slice(0, 200)),
        ].join('\n'),
        { message_thread_id: threadId },
      );
      return sent.message_id;
    }

    let firstMessageId: number | null = null;
    if (buffers.length === 1) {
      const sent = await api.sendPhoto(chatId, new InputFile(buffers[0]!, 'zalo-photo.jpg'), {
        message_thread_id: threadId,
        caption: caption || undefined,
        ...(caption && captionAsHtml ? { parse_mode: 'HTML' as const } : {}),
      });
      firstMessageId = sent.message_id;
    } else {
      const media = buffers.map((buf, i) => ({
        type: 'photo' as const,
        media: new InputFile(buf, `zalo-photo-${i + 1}.jpg`),
        ...(i === 0 && caption
          ? {
              caption,
              ...(captionAsHtml ? { parse_mode: 'HTML' as const } : {}),
            }
          : {}),
      }));
      const sent = await api.sendMediaGroup(chatId, media, {
        message_thread_id: threadId,
      });
      firstMessageId = sent[0]?.message_id ?? null;
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
        telegramMessageId: firstMessageId,
      },
      'Forwarded Zalo photo(s) → Telegram topic',
    );
    return firstMessageId;
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
