import type { ZaloMode } from '../zalo/types.js';
import { getDb, type ThreadKind } from './client.js';

export type MessageDirection = 'z2t' | 't2z';

export type MessageLink = {
  id: number;
  provider: ZaloMode;
  direction: MessageDirection;
  zaloMsgId: string;
  zaloCliMsgId: string | null;
  zaloUidFrom: string | null;
  zaloThreadId: string;
  threadKind: ThreadKind;
  telegramChatId: number;
  telegramMessageId: number;
  telegramTopicId: number | null;
  bodyText: string | null;
  createdAt: string;
};

type MessageLinkRow = {
  id: number;
  provider: string;
  direction: string;
  zalo_msg_id: string;
  zalo_cli_msg_id: string | null;
  zalo_uid_from: string | null;
  zalo_thread_id: string;
  thread_kind: string;
  telegram_chat_id: number;
  telegram_message_id: number;
  telegram_topic_id: number | null;
  body_text: string | null;
  created_at: string;
};

function mapRow(row: MessageLinkRow): MessageLink {
  return {
    id: row.id,
    provider: row.provider as ZaloMode,
    direction: row.direction as MessageDirection,
    zaloMsgId: row.zalo_msg_id,
    zaloCliMsgId: row.zalo_cli_msg_id,
    zaloUidFrom: row.zalo_uid_from,
    zaloThreadId: row.zalo_thread_id,
    threadKind: row.thread_kind as ThreadKind,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    telegramTopicId: row.telegram_topic_id,
    bodyText: row.body_text,
    createdAt: row.created_at,
  };
}

export type UpsertMessageLinkInput = {
  provider: ZaloMode;
  direction: MessageDirection;
  zaloMsgId: string;
  zaloCliMsgId?: string | null;
  zaloUidFrom?: string | null;
  zaloThreadId: string;
  threadKind: ThreadKind;
  telegramChatId: number;
  telegramMessageId: number;
  telegramTopicId?: number | null;
  bodyText?: string | null;
};

export function upsertMessageLink(input: UpsertMessageLinkInput): MessageLink {
  const db = getDb();
  const existingZalo = findMessageLinkByZalo(input.provider, input.zaloMsgId);
  const existingTg = findMessageLinkByTelegram(
    input.provider,
    input.telegramChatId,
    input.telegramMessageId,
  );

  const keepId =
    existingTg?.id ??
    existingZalo?.id ??
    null;

  if (existingZalo && existingZalo.id !== keepId) {
    db.prepare(`DELETE FROM message_links WHERE id = ?`).run(existingZalo.id);
  }
  if (existingTg && existingTg.id !== keepId) {
    db.prepare(`DELETE FROM message_links WHERE id = ?`).run(existingTg.id);
  }

  const now = new Date().toISOString();
  if (keepId != null) {
    db.prepare(
      `UPDATE message_links SET
         direction = ?,
         zalo_msg_id = ?,
         zalo_cli_msg_id = COALESCE(?, zalo_cli_msg_id),
         zalo_uid_from = COALESCE(?, zalo_uid_from),
         zalo_thread_id = ?,
         thread_kind = ?,
         telegram_chat_id = ?,
         telegram_message_id = ?,
         telegram_topic_id = ?,
         body_text = COALESCE(?, body_text)
       WHERE id = ?`,
    ).run(
      input.direction,
      input.zaloMsgId,
      input.zaloCliMsgId ?? null,
      input.zaloUidFrom ?? null,
      input.zaloThreadId,
      input.threadKind,
      input.telegramChatId,
      input.telegramMessageId,
      input.telegramTopicId ?? null,
      input.bodyText ?? null,
      keepId,
    );
  } else {
    db.prepare(
      `INSERT INTO message_links (
         provider, direction, zalo_msg_id, zalo_cli_msg_id, zalo_uid_from,
         zalo_thread_id, thread_kind, telegram_chat_id, telegram_message_id,
         telegram_topic_id, body_text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.provider,
      input.direction,
      input.zaloMsgId,
      input.zaloCliMsgId ?? null,
      input.zaloUidFrom ?? null,
      input.zaloThreadId,
      input.threadKind,
      input.telegramChatId,
      input.telegramMessageId,
      input.telegramTopicId ?? null,
      input.bodyText ?? null,
      now,
    );
  }

  const found = findMessageLinkByTelegram(
    input.provider,
    input.telegramChatId,
    input.telegramMessageId,
  );
  if (!found) {
    throw new Error('upsertMessageLink: row missing after upsert');
  }
  return found;
}

export function findMessageLinkByZalo(
  provider: ZaloMode,
  zaloMsgId: string,
): MessageLink | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM message_links WHERE provider = ? AND zalo_msg_id = ?`,
    )
    .get(provider, zaloMsgId) as MessageLinkRow | undefined;
  return row ? mapRow(row) : null;
}

export function findMessageLinkByTelegram(
  provider: ZaloMode,
  telegramChatId: number,
  telegramMessageId: number,
): MessageLink | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM message_links
       WHERE provider = ? AND telegram_chat_id = ? AND telegram_message_id = ?`,
    )
    .get(provider, telegramChatId, telegramMessageId) as MessageLinkRow | undefined;
  return row ? mapRow(row) : null;
}

export function setZaloCliMsgId(
  provider: ZaloMode,
  zaloMsgId: string,
  cliMsgId: string,
): void {
  getDb()
    .prepare(
      `UPDATE message_links SET zalo_cli_msg_id = ?
       WHERE provider = ? AND zalo_msg_id = ?`,
    )
    .run(cliMsgId, provider, zaloMsgId);
}

export function updateMessageLinkZaloIds(
  provider: ZaloMode,
  telegramChatId: number,
  telegramMessageId: number,
  zaloMsgId: string,
  zaloCliMsgId: string | null,
  bodyText?: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE message_links
       SET zalo_msg_id = ?,
           zalo_cli_msg_id = ?,
           body_text = COALESCE(?, body_text)
       WHERE provider = ? AND telegram_chat_id = ? AND telegram_message_id = ?`,
    )
    .run(
      zaloMsgId,
      zaloCliMsgId,
      bodyText ?? null,
      provider,
      telegramChatId,
      telegramMessageId,
    );
}

export function deleteMessageLink(id: number): void {
  getDb().prepare(`DELETE FROM message_links WHERE id = ?`).run(id);
}
