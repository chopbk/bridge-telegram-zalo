import { getDb, type CustomerRow, type SubscriptionStatus } from './client.js';
import type { ZaloMode } from '../zalo/types.js';

export type Customer = {
  zaloUserId: string;
  telegramTopicId: number;
  provider: ZaloMode;
  displayName: string | null;
  muted: boolean;
  blocked: boolean;
  subscriptionStatus: SubscriptionStatus;
  topicMissing: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Eligible for channel broadcast / normal outbound replies */
export function isReceivable(c: Customer): boolean {
  return (
    c.subscriptionStatus === 'approved' && !c.muted && !c.blocked && !c.topicMissing
  );
}

export function canAdminReply(c: Customer): boolean {
  return c.subscriptionStatus === 'approved' && !c.blocked;
}

function mapRow(row: CustomerRow): Customer {
  return {
    zaloUserId: row.zalo_user_id,
    telegramTopicId: row.telegram_topic_id,
    provider: row.provider,
    displayName: row.display_name,
    muted: row.muted === 1,
    blocked: row.blocked === 1,
    subscriptionStatus: row.subscription_status,
    topicMissing: row.topic_missing === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findByZaloUserId(
  zaloUserId: string,
  provider: ZaloMode,
): Customer | null {
  const row = getDb()
    .prepare('SELECT * FROM customers WHERE zalo_user_id = ? AND provider = ?')
    .get(zaloUserId, provider) as CustomerRow | undefined;
  return row ? mapRow(row) : null;
}

export function findByTopicId(topicId: number, provider?: ZaloMode): Customer | null {
  if (provider) {
    const row = getDb()
      .prepare('SELECT * FROM customers WHERE telegram_topic_id = ? AND provider = ?')
      .get(topicId, provider) as CustomerRow | undefined;
    return row ? mapRow(row) : null;
  }
  const row = getDb()
    .prepare('SELECT * FROM customers WHERE telegram_topic_id = ?')
    .get(topicId) as CustomerRow | undefined;
  return row ? mapRow(row) : null;
}

export function listCustomers(provider?: ZaloMode): Customer[] {
  if (provider) {
    const rows = getDb()
      .prepare('SELECT * FROM customers WHERE provider = ? ORDER BY created_at ASC')
      .all(provider) as CustomerRow[];
    return rows.map(mapRow);
  }
  const rows = getDb()
    .prepare('SELECT * FROM customers ORDER BY created_at ASC')
    .all() as CustomerRow[];
  return rows.map(mapRow);
}

export function listCustomersPage(opts: {
  provider: ZaloMode;
  page: number;
  pageSize: number;
  status?: SubscriptionStatus;
}): { items: Customer[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, opts.page);
  const offset = (page - 1) * opts.pageSize;
  const db = getDb();

  if (opts.status) {
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers WHERE provider = ? AND subscription_status = ?`,
      )
      .get(opts.provider, opts.status) as { n: number };
    const rows = db
      .prepare(
        `SELECT * FROM customers
         WHERE provider = ? AND subscription_status = ?
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(opts.provider, opts.status, opts.pageSize, offset) as CustomerRow[];
    return { items: rows.map(mapRow), total: totalRow.n, page, pageSize: opts.pageSize };
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM customers WHERE provider = ?`)
    .get(opts.provider) as { n: number };
  const rows = db
    .prepare(
      `SELECT * FROM customers WHERE provider = ?
       ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    )
    .all(opts.provider, opts.pageSize, offset) as CustomerRow[];
  return { items: rows.map(mapRow), total: totalRow.n, page, pageSize: opts.pageSize };
}

export function searchCustomers(
  provider: ZaloMode,
  query: string,
  limit = 20,
): Customer[] {
  const q = `%${query.trim()}%`;
  const rows = getDb()
    .prepare(
      `SELECT * FROM customers
       WHERE provider = ?
         AND (zalo_user_id LIKE ? OR IFNULL(display_name, '') LIKE ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(provider, q, q, limit) as CustomerRow[];
  return rows.map(mapRow);
}

export function listBroadcastTargets(provider: ZaloMode): Customer[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM customers
       WHERE provider = ?
         AND subscription_status = 'approved'
         AND muted = 0
         AND blocked = 0
         AND topic_missing = 0
       ORDER BY created_at ASC`,
    )
    .all(provider) as CustomerRow[];
  return rows.map(mapRow);
}

export function countByStatus(provider: ZaloMode): Record<SubscriptionStatus, number> {
  const rows = getDb()
    .prepare(
      `SELECT subscription_status AS status, COUNT(*) AS n
       FROM customers WHERE provider = ?
       GROUP BY subscription_status`,
    )
    .all(provider) as Array<{ status: SubscriptionStatus; n: number }>;
  const out: Record<SubscriptionStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    unsubscribed: 0,
  };
  for (const row of rows) out[row.status] = row.n;
  return out;
}

export function insertCustomer(input: {
  zaloUserId: string;
  telegramTopicId: number;
  provider: ZaloMode;
  displayName?: string | null;
  subscriptionStatus?: SubscriptionStatus;
}): Customer {
  const now = new Date().toISOString();
  const status = input.subscriptionStatus ?? 'pending';
  getDb()
    .prepare(
      `INSERT INTO customers
        (provider, zalo_user_id, telegram_topic_id, display_name, muted, blocked,
         subscription_status, topic_missing, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, 0, ?, ?)`,
    )
    .run(
      input.provider,
      input.zaloUserId,
      input.telegramTopicId,
      input.displayName ?? null,
      status,
      now,
      now,
    );
  return findByZaloUserId(input.zaloUserId, input.provider)!;
}

/** Returns existing row if conflict; does not throw on unique violation when race happens. */
export function tryInsertCustomer(input: {
  zaloUserId: string;
  telegramTopicId: number;
  provider: ZaloMode;
  displayName?: string | null;
  subscriptionStatus?: SubscriptionStatus;
}): { customer: Customer; inserted: boolean } {
  const existing = findByZaloUserId(input.zaloUserId, input.provider);
  if (existing) return { customer: existing, inserted: false };

  try {
    const customer = insertCustomer(input);
    return { customer, inserted: true };
  } catch {
    const again = findByZaloUserId(input.zaloUserId, input.provider);
    if (again) return { customer: again, inserted: false };
    throw new Error('Failed to insert customer after race');
  }
}

export function setMuted(
  zaloUserId: string,
  provider: ZaloMode,
  muted: boolean,
): Customer | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      'UPDATE customers SET muted = ?, updated_at = ? WHERE zalo_user_id = ? AND provider = ?',
    )
    .run(muted ? 1 : 0, now, zaloUserId, provider) as { changes: number };
  if (result.changes === 0) return null;
  return findByZaloUserId(zaloUserId, provider);
}

export function setMutedByTopic(
  topicId: number,
  provider: ZaloMode,
  muted: boolean,
): Customer | null {
  const customer = findByTopicId(topicId, provider);
  if (!customer) return null;
  return setMuted(customer.zaloUserId, provider, muted);
}

export function setBlocked(
  zaloUserId: string,
  provider: ZaloMode,
  blocked: boolean,
): Customer | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      'UPDATE customers SET blocked = ?, updated_at = ? WHERE zalo_user_id = ? AND provider = ?',
    )
    .run(blocked ? 1 : 0, now, zaloUserId, provider) as { changes: number };
  if (result.changes === 0) return null;
  return findByZaloUserId(zaloUserId, provider);
}

export function setBlockedByTopic(
  topicId: number,
  provider: ZaloMode,
  blocked: boolean,
): Customer | null {
  const customer = findByTopicId(topicId, provider);
  if (!customer) return null;
  return setBlocked(customer.zaloUserId, provider, blocked);
}

export function setSubscriptionStatus(
  zaloUserId: string,
  provider: ZaloMode,
  status: SubscriptionStatus,
): Customer | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE customers SET subscription_status = ?, updated_at = ?
       WHERE zalo_user_id = ? AND provider = ?`,
    )
    .run(status, now, zaloUserId, provider) as { changes: number };
  if (result.changes === 0) return null;
  return findByZaloUserId(zaloUserId, provider);
}

export function setSubscriptionStatusByTopic(
  topicId: number,
  provider: ZaloMode,
  status: SubscriptionStatus,
): Customer | null {
  const customer = findByTopicId(topicId, provider);
  if (!customer) return null;
  return setSubscriptionStatus(customer.zaloUserId, provider, status);
}

export function updateDisplayName(
  zaloUserId: string,
  provider: ZaloMode,
  displayName: string,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'UPDATE customers SET display_name = ?, updated_at = ? WHERE zalo_user_id = ? AND provider = ?',
    )
    .run(displayName, now, zaloUserId, provider);
}

export function setTopicMissing(
  zaloUserId: string,
  provider: ZaloMode,
  missing: boolean,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'UPDATE customers SET topic_missing = ?, updated_at = ? WHERE zalo_user_id = ? AND provider = ?',
    )
    .run(missing ? 1 : 0, now, zaloUserId, provider);
}

export function updateTopicId(
  zaloUserId: string,
  provider: ZaloMode,
  topicId: number,
): Customer | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE customers
       SET telegram_topic_id = ?, topic_missing = 0, updated_at = ?
       WHERE zalo_user_id = ? AND provider = ?`,
    )
    .run(topicId, now, zaloUserId, provider) as { changes: number };
  if (result.changes === 0) return null;
  return findByZaloUserId(zaloUserId, provider);
}

export function deleteCustomer(zaloUserId: string, provider: ZaloMode): Customer | null {
  const existing = findByZaloUserId(zaloUserId, provider);
  if (!existing) return null;
  getDb()
    .prepare('DELETE FROM customers WHERE zalo_user_id = ? AND provider = ?')
    .run(zaloUserId, provider);
  return existing;
}

export type CustomerPatch = {
  displayName?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  muted?: boolean;
  blocked?: boolean;
};

export function updateCustomer(
  zaloUserId: string,
  provider: ZaloMode,
  patch: CustomerPatch,
): Customer | null {
  const existing = findByZaloUserId(zaloUserId, provider);
  if (!existing) return null;

  const now = new Date().toISOString();
  const displayName =
    patch.displayName !== undefined ? patch.displayName : existing.displayName;
  const status = patch.subscriptionStatus ?? existing.subscriptionStatus;
  const muted = patch.muted !== undefined ? (patch.muted ? 1 : 0) : existing.muted ? 1 : 0;
  const blocked =
    patch.blocked !== undefined ? (patch.blocked ? 1 : 0) : existing.blocked ? 1 : 0;

  getDb()
    .prepare(
      `UPDATE customers
       SET display_name = ?, subscription_status = ?, muted = ?, blocked = ?, updated_at = ?
       WHERE zalo_user_id = ? AND provider = ?`,
    )
    .run(displayName, status, muted, blocked, now, zaloUserId, provider);

  return findByZaloUserId(zaloUserId, provider);
}

export function formatCustomerDetail(c: Customer): string {
  return [
    `name: ${c.displayName ?? '(không có)'}`,
    `zalo: ${c.zaloUserId}`,
    `topic: ${c.telegramTopicId}`,
    `status: ${c.subscriptionStatus}`,
    `muted: ${c.muted ? 'yes' : 'no'}`,
    `blocked: ${c.blocked ? 'yes' : 'no'}`,
    `topic_missing: ${c.topicMissing ? 'yes' : 'no'}`,
    `provider: ${c.provider}`,
    `created: ${c.createdAt}`,
    `updated: ${c.updatedAt}`,
  ].join('\n');
}
