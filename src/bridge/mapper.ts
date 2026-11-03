import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  deleteCustomer,
  findByTopicId,
  findByZaloUserId,
  listBroadcastTargets,
  listCustomers,
  listCustomersPage,
  searchCustomers,
  setBlockedByTopic,
  setMutedByTopic,
  setSubscriptionStatus,
  setSubscriptionStatusByTopic,
  setTopicMissing,
  tryInsertCustomer,
  updateCustomer,
  updateDisplayName,
  updateTopicId,
  type Customer,
  type CustomerPatch,
} from '../db/customers.js';
import type { SubscriptionStatus } from '../db/client.js';
import type { ZaloMode } from '../zalo/types.js';

export async function getOrCreateTopic(
  api: Api,
  zaloUserId: string,
  provider: ZaloMode,
  displayName?: string,
): Promise<Customer> {
  const existing = findByZaloUserId(zaloUserId, provider);
  if (existing) {
    if (displayName && displayName !== existing.displayName) {
      updateDisplayName(zaloUserId, provider, displayName);
      return { ...existing, displayName };
    }
    if (existing.topicMissing) {
      return recreateTopic(api, existing, displayName);
    }
    return existing;
  }

  return createTopicAndInsert(api, zaloUserId, provider, displayName);
}

async function createTopicAndInsert(
  api: Api,
  zaloUserId: string,
  provider: ZaloMode,
  displayName?: string,
  subscriptionStatus: SubscriptionStatus = 'pending',
  threadKind: 'user' | 'group' = 'user',
): Promise<Customer> {
  const env = getEnv();
  const prefix = threadKind === 'group' ? 'G' : 'Zalo';
  const title = truncateTopicTitle(displayName || `${prefix} ${zaloUserId}`);
  const topic = await api.createForumTopic(env.telegramForumGroupId, title);
  const topicId = topic.message_thread_id;

  const { customer, inserted } = tryInsertCustomer({
    zaloUserId,
    telegramTopicId: topicId,
    provider,
    displayName: displayName ?? null,
    subscriptionStatus,
    threadKind,
  });

  if (!inserted) {
    // Race: another inbound won — delete orphan topic best-effort
    try {
      await api.deleteForumTopic(env.telegramForumGroupId, topicId);
    } catch (err) {
      logger.warn({ err, topicId }, 'Failed to delete orphan forum topic');
    }
    logger.info(
      { zaloUserId, topicId: customer.telegramTopicId, provider },
      'Reused existing customer after topic race',
    );
    return customer;
  }

  logger.info(
    { zaloUserId, topicId: customer.telegramTopicId, provider },
    'Created Telegram topic for Zalo user',
  );
  return customer;
}

async function recreateTopic(
  api: Api,
  customer: Customer,
  displayName?: string,
): Promise<Customer> {
  const env = getEnv();
  const title = truncateTopicTitle(
    displayName || customer.displayName || `Zalo ${customer.zaloUserId}`,
  );
  const topic = await api.createForumTopic(env.telegramForumGroupId, title);
  const updated = updateTopicId(customer.zaloUserId, customer.provider, topic.message_thread_id);
  logger.info(
    { zaloUserId: customer.zaloUserId, topicId: topic.message_thread_id },
    'Recreated Telegram topic',
  );
  return updated ?? { ...customer, telegramTopicId: topic.message_thread_id, topicMissing: false };
}

export async function recreateTopicById(
  api: Api,
  topicId: number,
  provider: ZaloMode,
): Promise<Customer | null> {
  const customer = findByTopicId(topicId, provider);
  if (!customer) return null;
  setTopicMissing(customer.zaloUserId, provider, true);
  return recreateTopic(api, { ...customer, topicMissing: true });
}

export function markTopicMissing(customer: Customer): void {
  setTopicMissing(customer.zaloUserId, customer.provider, true);
}

export function customerByTopic(topicId: number, provider: ZaloMode): Customer | null {
  return findByTopicId(topicId, provider);
}

export function allCustomers(provider: ZaloMode): Customer[] {
  return listCustomers(provider);
}

export function pageCustomers(
  provider: ZaloMode,
  page: number,
  status?: SubscriptionStatus,
): ReturnType<typeof listCustomersPage> {
  return listCustomersPage({
    provider,
    page,
    pageSize: getEnv().LIST_PAGE_SIZE,
    status,
  });
}

export function findCustomers(provider: ZaloMode, query: string): Customer[] {
  return searchCustomers(provider, query, getEnv().LIST_PAGE_SIZE);
}

export function broadcastTargets(provider: ZaloMode): Customer[] {
  return listBroadcastTargets(provider);
}

export function muteByTopic(
  topicId: number,
  provider: ZaloMode,
  muted: boolean,
): Customer | null {
  return setMutedByTopic(topicId, provider, muted);
}

export function blockByTopic(
  topicId: number,
  provider: ZaloMode,
  blocked: boolean,
): Customer | null {
  return setBlockedByTopic(topicId, provider, blocked);
}

export function setStatusByTopic(
  topicId: number,
  provider: ZaloMode,
  status: SubscriptionStatus,
): Customer | null {
  return setSubscriptionStatusByTopic(topicId, provider, status);
}

export function setStatusByZaloId(
  zaloUserId: string,
  provider: ZaloMode,
  status: SubscriptionStatus,
): Customer | null {
  return setSubscriptionStatus(zaloUserId, provider, status);
}

export function customerByZaloId(
  zaloUserId: string,
  provider: ZaloMode,
): Customer | null {
  return findByZaloUserId(zaloUserId, provider);
}

/** Admin thêm khách vào danh sách cho phép (approved) + tạo topic. */
export async function addAllowedCustomer(
  api: Api,
  provider: ZaloMode,
  zaloUserId: string,
  displayName?: string,
  threadKind: 'user' | 'group' = 'user',
): Promise<{ customer: Customer; created: boolean }> {
  const existing = findByZaloUserId(zaloUserId, provider);
  if (existing) {
    const updated =
      updateCustomer(zaloUserId, provider, {
        subscriptionStatus: 'approved',
        blocked: false,
        threadKind,
        ...(displayName ? { displayName } : {}),
      }) ?? existing;
    return { customer: updated, created: false };
  }

  const customer = await createTopicAndInsert(
    api,
    zaloUserId,
    provider,
    displayName,
    'approved',
    threadKind,
  );
  return { customer, created: true };
}

export function editCustomer(
  zaloUserId: string,
  provider: ZaloMode,
  patch: CustomerPatch,
): Customer | null {
  return updateCustomer(zaloUserId, provider, patch);
}

/** Xóa khỏi DB; best-effort xóa forum topic trên Telegram. */
export async function removeCustomer(
  api: Api,
  provider: ZaloMode,
  zaloUserId: string,
): Promise<Customer | null> {
  const existing = deleteCustomer(zaloUserId, provider);
  if (!existing) return null;

  try {
    await api.deleteForumTopic(getEnv().telegramForumGroupId, existing.telegramTopicId);
  } catch (err) {
    logger.warn(
      { err, topicId: existing.telegramTopicId, zaloUserId },
      'Failed to delete forum topic after customer remove',
    );
  }
  return existing;
}

function truncateTopicTitle(name: string): string {
  const cleaned = name.replace(/[\n\r]/g, ' ').trim() || 'Zalo user';
  return cleaned.length > 128 ? cleaned.slice(0, 125) + '...' : cleaned;
}
