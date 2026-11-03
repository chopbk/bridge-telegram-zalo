import { getDb, type CustomerRow } from './client.js';

export type Customer = {
  zaloUserId: string;
  telegramTopicId: number;
  provider: 'bot' | 'personal';
  displayName: string | null;
  muted: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: CustomerRow): Customer {
  return {
    zaloUserId: row.zalo_user_id,
    telegramTopicId: row.telegram_topic_id,
    provider: row.provider,
    displayName: row.display_name,
    muted: row.muted === 1,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findByZaloUserId(zaloUserId: string): Customer | null {
  const row = getDb()
    .prepare('SELECT * FROM customers WHERE zalo_user_id = ?')
    .get(zaloUserId) as CustomerRow | undefined;
  return row ? mapRow(row) : null;
}

export function findByTopicId(topicId: number): Customer | null {
  const row = getDb()
    .prepare('SELECT * FROM customers WHERE telegram_topic_id = ?')
    .get(topicId) as CustomerRow | undefined;
  return row ? mapRow(row) : null;
}

export function listCustomers(): Customer[] {
  const rows = getDb()
    .prepare('SELECT * FROM customers ORDER BY created_at ASC')
    .all() as CustomerRow[];
  return rows.map(mapRow);
}

export function listBroadcastTargets(): Customer[] {
  const rows = getDb()
    .prepare('SELECT * FROM customers WHERE active = 1 AND muted = 0 ORDER BY created_at ASC')
    .all() as CustomerRow[];
  return rows.map(mapRow);
}

export function insertCustomer(input: {
  zaloUserId: string;
  telegramTopicId: number;
  provider: 'bot' | 'personal';
  displayName?: string | null;
}): Customer {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO customers
        (zalo_user_id, telegram_topic_id, provider, display_name, muted, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .run(
      input.zaloUserId,
      input.telegramTopicId,
      input.provider,
      input.displayName ?? null,
      now,
      now,
    );
  return findByZaloUserId(input.zaloUserId)!;
}

export function setMuted(zaloUserId: string, muted: boolean): Customer | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare('UPDATE customers SET muted = ?, updated_at = ? WHERE zalo_user_id = ?')
    .run(muted ? 1 : 0, now, zaloUserId) as { changes: number };
  if (result.changes === 0) return null;
  return findByZaloUserId(zaloUserId);
}

export function setMutedByTopic(topicId: number, muted: boolean): Customer | null {
  const customer = findByTopicId(topicId);
  if (!customer) return null;
  return setMuted(customer.zaloUserId, muted);
}

export function updateDisplayName(zaloUserId: string, displayName: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE customers SET display_name = ?, updated_at = ? WHERE zalo_user_id = ?')
    .run(displayName, now, zaloUserId);
}
