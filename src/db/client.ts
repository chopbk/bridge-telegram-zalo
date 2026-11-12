import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getEnv } from '../config/env.js';

export type SubscriptionStatus = 'pending' | 'approved' | 'rejected' | 'unsubscribed';
export type ThreadKind = 'user' | 'group';

export type CustomerRow = {
  provider: 'bot' | 'personal';
  zalo_user_id: string;
  telegram_topic_id: number;
  display_name: string | null;
  muted: number;
  blocked: number;
  /** 1 = chỉ Zalo→Telegram, không reply Telegram→Zalo */
  inbound_only: number;
  subscription_status: SubscriptionStatus;
  topic_missing: number;
  thread_kind: ThreadKind;
  created_at: string;
  updated_at: string;
};

export type AppDatabase = Database.Database;

let db: AppDatabase | null = null;

export function getDb(): AppDatabase {
  if (db) return db;
  const path = getEnv().DATABASE_PATH;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function tableExists(database: AppDatabase, name: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function columnNames(database: AppDatabase, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function migrate(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const versionRow = database
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  const version = versionRow ? Number(versionRow.value) : 0;

  if (version < 2) {
    migrateToV2(database);
    database
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  if (version < 3) {
    migrateToV3(database);
    database
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '3')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  if (version < 4) {
    migrateToV4(database);
    database
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '4')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  if (version < 5) {
    migrateToV5(database);
    database
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '5')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      provider TEXT NOT NULL,
      message_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (provider, message_id)
    );

    CREATE TABLE IF NOT EXISTS inbound_events (
      provider TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'done', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, message_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('broadcast', 'broadcast_item')),
      parent_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'failed')),
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_next
      ON jobs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id);
  `);
}

function migrateToV2(database: AppDatabase): void {
  const hasCustomers = tableExists(database, 'customers');
  if (!hasCustomers) {
    createCustomersV2(database);
    return;
  }

  const cols = columnNames(database, 'customers');
  const alreadyV2 =
    cols.has('subscription_status') && cols.has('blocked') && cols.has('topic_missing');

  if (alreadyV2) {
    // Ensure composite PK by rebuilding if still on old single-column PK shape
    const pkInfo = database.prepare(`PRAGMA table_info(customers)`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCols = pkInfo.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    if (pkCols.length === 2 && pkCols[0]?.name === 'provider' && pkCols[1]?.name === 'zalo_user_id') {
      return;
    }
  }

  database.exec(`
    CREATE TABLE customers_v2 (
      provider TEXT NOT NULL CHECK (provider IN ('bot', 'personal')),
      zalo_user_id TEXT NOT NULL,
      telegram_topic_id INTEGER NOT NULL UNIQUE,
      display_name TEXT,
      muted INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      subscription_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (subscription_status IN ('pending', 'approved', 'rejected', 'unsubscribed')),
      topic_missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, zalo_user_id)
    );
  `);

  if (cols.has('subscription_status')) {
    database.exec(`
      INSERT INTO customers_v2
        (provider, zalo_user_id, telegram_topic_id, display_name, muted, blocked,
         subscription_status, topic_missing, created_at, updated_at)
      SELECT
        provider, zalo_user_id, telegram_topic_id, display_name, muted,
        COALESCE(blocked, 0),
        COALESCE(subscription_status, 'pending'),
        COALESCE(topic_missing, 0),
        created_at, updated_at
      FROM customers;
    `);
  } else {
    // Legacy: backfill pending so nothing broadcasts until re-approved
    database.exec(`
      INSERT INTO customers_v2
        (provider, zalo_user_id, telegram_topic_id, display_name, muted, blocked,
         subscription_status, topic_missing, created_at, updated_at)
      SELECT
        provider, zalo_user_id, telegram_topic_id, display_name, muted,
        0, 'pending', 0, created_at, updated_at
      FROM customers;
    `);
  }

  database.exec(`
    DROP TABLE customers;
    ALTER TABLE customers_v2 RENAME TO customers;
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_topic ON customers(telegram_topic_id);
    CREATE INDEX IF NOT EXISTS idx_customers_broadcast
      ON customers(provider, subscription_status, muted, blocked);
  `);
}

function createCustomersV2(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE customers (
      provider TEXT NOT NULL CHECK (provider IN ('bot', 'personal')),
      zalo_user_id TEXT NOT NULL,
      telegram_topic_id INTEGER NOT NULL UNIQUE,
      display_name TEXT,
      muted INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      inbound_only INTEGER NOT NULL DEFAULT 0,
      subscription_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (subscription_status IN ('pending', 'approved', 'rejected', 'unsubscribed')),
      topic_missing INTEGER NOT NULL DEFAULT 0,
      thread_kind TEXT NOT NULL DEFAULT 'user'
        CHECK (thread_kind IN ('user', 'group')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, zalo_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_customers_topic ON customers(telegram_topic_id);
    CREATE INDEX IF NOT EXISTS idx_customers_broadcast
      ON customers(provider, subscription_status, muted, blocked);
  `);
}

function migrateToV3(database: AppDatabase): void {
  if (!tableExists(database, 'customers')) {
    createCustomersV2(database);
    return;
  }
  const cols = columnNames(database, 'customers');
  if (!cols.has('thread_kind')) {
    database.exec(
      `ALTER TABLE customers ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'user'`,
    );
  }
}

function migrateToV4(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_activity (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_kind TEXT NOT NULL CHECK (thread_kind IN ('user', 'group')),
      last_active_at INTEGER NOT NULL,
      display_name TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_activity_recent
      ON thread_activity(provider, thread_kind, last_active_at DESC);
  `);
}

function migrateToV5(database: AppDatabase): void {
  if (!tableExists(database, 'customers')) {
    createCustomersV2(database);
  }
  const cols = columnNames(database, 'customers');
  if (!cols.has('inbound_only')) {
    database.exec(
      `ALTER TABLE customers ADD COLUMN inbound_only INTEGER NOT NULL DEFAULT 0`,
    );
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
