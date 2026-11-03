import logger from '../config/logger.js';
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
  const customer = customerByTopic(topicId);
  if (!customer) {
    logger.warn({ topicId }, 'No customer mapped for topic — skip outbound');
    return;
  }
  if (!customer.active) {
    logger.info({ topicId, zaloUserId: customer.zaloUserId }, 'Customer inactive — skip');
    return;
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
