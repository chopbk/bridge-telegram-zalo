import logger from '../config/logger.js';
import { canAdminReply } from '../db/customers.js';
import type { ZaloAdapter, ZaloImageAttachment } from '../zalo/types.js';
import {
  telegramEntitiesToZaloStyles,
  type TelegramEntityLike,
} from './format.js';
import { customerByTopic } from './mapper.js';

/**
 * Luồng B: Telegram topic → Zalo (text)
 */
export async function forwardTopicToZalo(
  adapter: ZaloAdapter,
  topicId: number,
  text: string,
  entities?: TelegramEntityLike[],
): Promise<void> {
  const customer = requireReceivableCustomer(adapter, topicId);
  const styles = telegramEntitiesToZaloStyles(text, entities);

  try {
    const result = await adapter.sendText(customer.zaloUserId, text, {
      threadKind: customer.threadKind,
      styles: styles.length ? styles : undefined,
    });
    logger.info(
      {
        topicId,
        zaloUserId: customer.zaloUserId,
        threadKind: customer.threadKind,
        messageId: result.messageId,
        styleCount: styles.length,
      },
      'Forwarded Telegram topic → Zalo',
    );
  } catch (err) {
    logger.error(
      { err, topicId, zaloUserId: customer.zaloUserId, threadKind: customer.threadKind },
      'Outbound Tele→Zalo failed',
    );
    throw err;
  }
}

/**
 * Luồng B: Telegram topic → Zalo (1 hoặc nhiều ảnh)
 */
export async function forwardTopicImagesToZalo(
  adapter: ZaloAdapter,
  topicId: number,
  images: ZaloImageAttachment[],
  caption?: string,
  captionEntities?: TelegramEntityLike[],
): Promise<void> {
  const customer = requireReceivableCustomer(adapter, topicId);

  if (!adapter.sendImages) {
    throw new Error('Adapter hiện tại chưa hỗ trợ gửi ảnh sang Zalo');
  }
  if (!images.length) {
    throw new Error('Không có ảnh để gửi');
  }

  const styles = telegramEntitiesToZaloStyles(caption ?? '', captionEntities);

  try {
    const result = await adapter.sendImages(customer.zaloUserId, images, {
      threadKind: customer.threadKind,
      caption,
      styles: styles.length ? styles : undefined,
    });
    logger.info(
      {
        topicId,
        zaloUserId: customer.zaloUserId,
        threadKind: customer.threadKind,
        count: images.length,
        messageId: result.messageId,
      },
      'Forwarded Telegram photo(s) → Zalo',
    );
  } catch (err) {
    logger.error(
      {
        err,
        topicId,
        zaloUserId: customer.zaloUserId,
        threadKind: customer.threadKind,
        count: images.length,
      },
      'Outbound Tele photo→Zalo failed',
    );
    throw err;
  }
}

function requireReceivableCustomer(adapter: ZaloAdapter, topicId: number) {
  const customer = customerByTopic(topicId, adapter.mode);
  if (!customer) {
    logger.warn({ topicId }, 'No customer mapped for topic — skip outbound');
    throw new Error('Không có khách gắn với topic này');
  }
  if (!canAdminReply(customer)) {
    logger.info(
      {
        topicId,
        zaloUserId: customer.zaloUserId,
        status: customer.subscriptionStatus,
        blocked: customer.blocked,
        inboundOnly: customer.inboundOnly,
      },
      'Customer not receivable for reply — skip',
    );
    if (customer.inboundOnly) {
      throw new Error(
        'Topic đang chế độ chỉ đọc (Zalo→Telegram). Dùng /twoway để bật lại reply sang Zalo.',
      );
    }
    throw new Error(
      `Khách chưa đủ điều kiện nhận tin (status=${customer.subscriptionStatus}, blocked=${customer.blocked})`,
    );
  }
  return customer;
}
