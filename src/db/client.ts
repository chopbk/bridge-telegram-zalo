import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getEnv } from '../config/env.js';

export type CustomerRow = {
  zalo_user_id: string;
  telegram_topic_id: number;
  provider: 'bot' | 'personal';
  display_name: string | null;
  muted: number;
  active: number;
  created_at: string;
  updated_at: string;
};

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const path = getEnv().DATABASE_PATH;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      zalo_user_id TEXT PRIMARY KEY,
      telegram_topic_id INTEGER NOT NULL UNIQUE,
      provider TEXT NOT NULL CHECK (provider IN ('bot', 'personal')),
      display_name TEXT,
      muted INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customers_topic ON customers(telegram_topic_id);
    CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(active, muted);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
