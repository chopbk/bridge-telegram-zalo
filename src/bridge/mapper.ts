import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  findByTopicId,
  findByZaloUserId,
  insertCustomer,
  listBroadcastTargets,
  listCustomers,
  setMutedByTopic,
  updateDisplayName,
  type Customer,
} from '../db/customers.js';
import type { ZaloMode } from '../zalo/types.js';

export async function getOrCreateTopic(
  api: Api,
  zaloUserId: string,
  provider: ZaloMode,
  displayName?: string,
): Promise<Customer> {
  const existing = findByZaloUserId(zaloUserId);
  if (existing) {
    if (displayName && displayName !== existing.displayName) {
      updateDisplayName(zaloUserId, displayName);
      return { ...existing, displayName };
    }
    return existing;
  }

  const env = getEnv();
  const title = truncateTopicTitle(displayName || `Zalo ${zaloUserId}`);
  const topic = await api.createForumTopic(env.telegramForumGroupId, title);

  const customer = insertCustomer({
    zaloUserId,
    telegramTopicId: topic.message_thread_id,
    provider,
    displayName: displayName ?? null,
  });

  logger.info(
    { zaloUserId, topicId: customer.telegramTopicId, provider },
    'Created Telegram topic for Zalo user',
  );
  return customer;
}

export function customerByTopic(topicId: number): Customer | null {
  return findByTopicId(topicId);
}

export function allCustomers(): Customer[] {
  return listCustomers();
}

export function broadcastTargets(): Customer[] {
  return listBroadcastTargets();
}

export function muteByTopic(topicId: number, muted: boolean): Customer | null {
  return setMutedByTopic(topicId, muted);
}

function truncateTopicTitle(name: string): string {
  const cleaned = name.replace(/[\n\r]/g, ' ').trim() || 'Zalo user';
  return cleaned.length > 128 ? cleaned.slice(0, 125) + '...' : cleaned;
}
