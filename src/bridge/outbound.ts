import logger from '../config/logger.js';
import { canAdminReply } from '../db/customers.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { customerByTopic } from './mapper.js';

/**
 * Luồng B: Telegram topic → Zalo
 */
export async function forwardTopicToZalo(
  adapter: ZaloAdapter,
  topicId: number,
  text: string,
): Promise<void> {
  const customer = customerByTopic(topicId, adapter.mode);
  if (!customer) {
    logger.warn({ topicId }, 'No customer mapped for topic — skip outbound');
    return;
  }
  if (!canAdminReply(customer)) {
    logger.info(
      {
        topicId,
        zaloUserId: customer.zaloUserId,
        status: customer.subscriptionStatus,
        blocked: customer.blocked,
      },
      'Customer not receivable for reply — skip',
    );
    throw new Error(
      `Khách chưa đủ điều kiện nhận tin (status=${customer.subscriptionStatus}, blocked=${customer.blocked})`,
    );
  }

  try {
    const result = await adapter.sendText(customer.zaloUserId, text);
    logger.info(
      { topicId, zaloUserId: customer.zaloUserId, messageId: result.messageId },
      'Forwarded Telegram topic → Zalo',
    );
  } catch (err) {
    logger.error({ err, topicId, zaloUserId: customer.zaloUserId }, 'Outbound Tele→Zalo failed');
    throw err;
  }
}
