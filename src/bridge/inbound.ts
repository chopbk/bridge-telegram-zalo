import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { getOrCreateTopic } from './mapper.js';

/**
 * Luồng A: Zalo → Telegram topic
 */
export function wireInbound(api: Api, adapter: ZaloAdapter): void {
  adapter.onInbound(async (msg) => {
    try {
      const customer = await getOrCreateTopic(api, msg.zaloUserId, adapter.mode, msg.displayName);
      await api.sendMessage(getEnv().telegramForumGroupId, msg.text, {
        message_thread_id: customer.telegramTopicId,
      });
      logger.info(
        { zaloUserId: msg.zaloUserId, topicId: customer.telegramTopicId },
        'Forwarded Zalo → Telegram topic',
      );
    } catch (err) {
      logger.error({ err, zaloUserId: msg.zaloUserId }, 'Inbound Zalo→Tele failed');
    }
  });
}
