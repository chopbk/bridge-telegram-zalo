import logger from '../config/logger.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { broadcastTargets } from './mapper.js';

/**
 * Luồng C: Telegram channel → fan-out Zalo
 */
export async function broadcastChannelText(
  adapter: ZaloAdapter,
  text: string,
): Promise<{ ok: number; fail: number }> {
  const targets = broadcastTargets();
  let ok = 0;
  let fail = 0;

  logger.info({ count: targets.length }, 'Broadcasting channel post to Zalo customers');

  for (const customer of targets) {
    try {
      await adapter.sendText(customer.zaloUserId, text);
      ok += 1;
    } catch (err) {
      fail += 1;
      logger.error(
        { err, zaloUserId: customer.zaloUserId },
        'Broadcast send failed for customer',
      );
    }
  }

  logger.info({ ok, fail }, 'Broadcast finished');
  return { ok, fail };
}
