import type { Api } from 'grammy';
import logger from '../config/logger.js';
import {
  deleteMessageLink,
  findMessageLinkByTelegram,
  findMessageLinkByZalo,
  updateMessageLinkZaloIds,
  type MessageLink,
} from '../db/message-links.js';
import type { NormalizedUndo, ZaloAdapter } from '../zalo/types.js';
import {
  telegramEntitiesToZaloStyles,
  type TelegramEntityLike,
} from './format.js';

/** msgId Zalo đang undo từ phía bridge — bỏ qua echo undo → xoá TG */
const suppressedZaloUndos = new Map<string, number>();
const SUPPRESS_TTL_MS = 60_000;

function suppressKey(provider: string, zaloMsgId: string): string {
  return `${provider}:${zaloMsgId}`;
}

export function suppressZaloUndoEcho(provider: string, zaloMsgId: string): void {
  suppressedZaloUndos.set(suppressKey(provider, zaloMsgId), Date.now() + SUPPRESS_TTL_MS);
}

function isZaloUndoSuppressed(provider: string, zaloMsgId: string): boolean {
  const key = suppressKey(provider, zaloMsgId);
  const until = suppressedZaloUndos.get(key);
  if (until == null) return false;
  if (Date.now() > until) {
    suppressedZaloUndos.delete(key);
    return false;
  }
  return true;
}

/**
 * Zalo thu hồi tin → xoá tin tương ứng trên Telegram.
 */
export function wireZaloUndoSync(api: Api, adapter: ZaloAdapter): void {
  if (!adapter.onUndo) return;
  adapter.onUndo(async (undo) => {
    try {
      await handleZaloUndo(api, adapter, undo);
    } catch (err) {
      logger.error({ err, undo }, 'Zalo undo → Telegram delete failed');
    }
  });
}

async function handleZaloUndo(
  api: Api,
  adapter: ZaloAdapter,
  undo: NormalizedUndo,
): Promise<void> {
  const zaloMsgId = undo.targetMsgId;
  if (!zaloMsgId) return;

  if (isZaloUndoSuppressed(adapter.mode, zaloMsgId)) {
    logger.info(
      { zaloMsgId, provider: adapter.mode },
      'Skip Zalo undo echo (bridge-initiated)',
    );
    return;
  }

  const link = findMessageLinkByZalo(adapter.mode, zaloMsgId);
  if (!link) {
    logger.info(
      { zaloMsgId, threadId: undo.zaloThreadId },
      'Zalo undo without message link — skip',
    );
    return;
  }

  try {
    await api.deleteMessage(link.telegramChatId, link.telegramMessageId);
    logger.info(
      {
        zaloMsgId,
        telegramMessageId: link.telegramMessageId,
        topicId: link.telegramTopicId,
      },
      'Synced Zalo undo → deleted Telegram message',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Đã xoá rồi / không còn quyền — vẫn dọn map
    if (!/message to delete not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(msg)) {
      logger.warn(
        { err, zaloMsgId, telegramMessageId: link.telegramMessageId },
        'Failed to delete Telegram message after Zalo undo',
      );
    }
  }
  deleteMessageLink(link.id);
}

/**
 * Admin xoá tin trên Telegram (qua /del reply) → thu hồi trên Zalo.
 */
export async function syncTelegramDeleteToZalo(
  adapter: ZaloAdapter,
  chatId: number,
  messageId: number,
): Promise<{ ok: true; link: MessageLink } | { ok: false; reason: string }> {
  if (!adapter.undoMessage) {
    return { ok: false, reason: 'Adapter chưa hỗ trợ thu hồi tin Zalo' };
  }

  const link = findMessageLinkByTelegram(adapter.mode, chatId, messageId);
  if (!link) {
    return {
      ok: false,
      reason: 'Không tìm thấy tin Zalo tương ứng (chỉ xoá được tin đã bridge)',
    };
  }

  if (!link.zaloCliMsgId) {
    return {
      ok: false,
      reason:
        'Chưa kịp lưu cliMsgId Zalo — đợi vài giây rồi /del lại, hoặc tin quá cũ',
    };
  }

  suppressZaloUndoEcho(adapter.mode, link.zaloMsgId);
  try {
    await adapter.undoMessage({
      msgId: link.zaloMsgId,
      cliMsgId: link.zaloCliMsgId,
      threadId: link.zaloThreadId,
      threadKind: link.threadKind,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Thu hồi Zalo thất bại: ${detail}` };
  }

  try {
    // Xoá luôn tin TG nếu còn (admin có thể /del reply mà chưa xoá native)
    // Caller thường đã xoá hoặc sẽ xoá — best effort
  } catch {
    // ignore
  }

  deleteMessageLink(link.id);
  logger.info(
    {
      zaloMsgId: link.zaloMsgId,
      telegramMessageId: messageId,
      direction: link.direction,
    },
    'Synced Telegram delete → Zalo undo',
  );
  return { ok: true, link };
}

/**
 * Admin sửa tin trên Telegram → thu hồi + gửi lại trên Zalo (zca-js không có edit).
 */
export async function syncTelegramEditToZalo(
  adapter: ZaloAdapter,
  chatId: number,
  messageId: number,
  newText: string,
  entities?: TelegramEntityLike[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!adapter.undoMessage) {
    return { ok: false, reason: 'Adapter chưa hỗ trợ sửa/thu hồi Zalo' };
  }

  const link = findMessageLinkByTelegram(adapter.mode, chatId, messageId);
  if (!link) {
    return { ok: false, reason: 'no-link' };
  }

  // Chỉ sync sửa tin admin đã gửi sang Zalo (t2z). Tin bot forward (z2t) ít khi sửa được.
  if (link.direction !== 't2z') {
    return { ok: false, reason: 'not-outbound' };
  }

  if (link.bodyText != null && link.bodyText === newText) {
    return { ok: true };
  }

  if (link.zaloCliMsgId) {
    suppressZaloUndoEcho(adapter.mode, link.zaloMsgId);
    try {
      await adapter.undoMessage({
        msgId: link.zaloMsgId,
        cliMsgId: link.zaloCliMsgId,
        threadId: link.zaloThreadId,
        threadKind: link.threadKind,
      });
    } catch (err) {
      logger.warn(
        { err, zaloMsgId: link.zaloMsgId },
        'Undo before edit failed — vẫn gửi tin mới',
      );
    }
  }

  const styles = telegramEntitiesToZaloStyles(newText, entities);
  try {
    const result = await adapter.sendText(link.zaloThreadId, newText, {
      threadKind: link.threadKind,
      styles: styles.length ? styles : undefined,
    });
    updateMessageLinkZaloIds(
      adapter.mode,
      chatId,
      messageId,
      result.messageId,
      result.cliMsgId ?? null,
      newText,
    );
    logger.info(
      {
        oldZaloMsgId: link.zaloMsgId,
        newZaloMsgId: result.messageId,
        telegramMessageId: messageId,
      },
      'Synced Telegram edit → Zalo undo+resend',
    );
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: detail };
  }
}
