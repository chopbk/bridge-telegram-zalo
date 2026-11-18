import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { findByZaloUserId } from '../db/customers.js';
import {
  claimNextBroadcastItem,
  createBroadcastJob,
  finalizeBroadcastParent,
  getJob,
  listFailedBroadcastItems,
  markJobDone,
  markJobFailedOrRetry,
  msUntilNextPendingItem,
  recoverStuckJobs,
  requeueFailedBroadcastItems,
  type BroadcastItemPayload,
} from '../db/jobs.js';
import { upsertMessageLink } from '../db/message-links.js';
import { appendSignaturePlain } from '../db/settings.js';
import { notifyAdmins } from '../telegram/notify.js';
import type { ZaloAdapter, ZaloImageAttachment, ZaloSendResult } from '../zalo/types.js';
import { bufferToZaloImage, downloadToBuffer, telegramFileUrl } from './media.js';
import { broadcastTargets } from './mapper.js';

/** Cache ảnh đã tải trong một lần drain (tránh getFile N lần cho N khách). */
const photoCache = new Map<string, ZaloImageAttachment[]>();

function photoCacheKey(fileIds: string[]): string {
  return fileIds.join('|');
}

export type BroadcastResult = {
  ok: number;
  fail: number;
  jobId: number;
  failedUserIds: string[];
};

type BroadcastOpts = {
  text: string;
  imageFileIds?: string[];
  channelMessageId?: number;
  report?: boolean;
  /** Cần để mirror tin vào topic + lưu map /del → thu hồi Zalo */
  api: Api;
};

/**
 * Luồng C: Telegram channel → fan-out Zalo (persisted jobs + retry)
 * Đồng thời mirror vào topic Telegram để admin /del → thu hồi Zalo.
 */
export async function broadcastChannelText(
  adapter: ZaloAdapter,
  text: string,
  opts: { api: Api; channelMessageId?: number; report?: boolean },
): Promise<BroadcastResult> {
  return enqueueAndDrainBroadcast(adapter, {
    text,
    channelMessageId: opts.channelMessageId,
    report: opts.report,
    api: opts.api,
  });
}

/** Broadcast ảnh channel (file_id Telegram — tải 1 lần rồi gửi từng khách). */
export async function broadcastChannelPhotos(
  adapter: ZaloAdapter,
  imageFileIds: string[],
  opts: { api: Api; caption?: string; channelMessageId?: number; report?: boolean },
): Promise<BroadcastResult> {
  if (!imageFileIds.length) {
    throw new Error('broadcastChannelPhotos: empty imageFileIds');
  }
  return enqueueAndDrainBroadcast(adapter, {
    text: (opts.caption ?? '').trim(),
    imageFileIds,
    channelMessageId: opts.channelMessageId,
    report: opts.report,
    api: opts.api,
  });
}

async function enqueueAndDrainBroadcast(
  adapter: ZaloAdapter,
  opts: BroadcastOpts,
): Promise<BroadcastResult> {
  const targets = broadcastTargets(adapter.mode);

  // Tải ảnh trước khi tạo job — fail sớm nếu Telegram timeout / chặn mạng
  if (opts.imageFileIds?.length) {
    try {
      const images = await downloadTelegramFileIds(opts.imageFileIds);
      photoCache.set(photoCacheKey(opts.imageFileIds), images);
      logger.info(
        { count: images.length, bytes: images.reduce((s, i) => s + i.data.length, 0) },
        'Channel photos downloaded once for broadcast',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to download channel photos from Telegram');
      throw new Error(
        `Không tải được ảnh từ Telegram (timeout/mạng tới api.telegram.org). Thử lại hoặc kiểm tra mạng/VPN. Chi tiết: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Chữ ký chỉ áp dụng channel → Zalo (không dùng trong topic)
  const textWithSig = appendSignaturePlain(opts.text);

  const { parentId } = createBroadcastJob({
    text: textWithSig,
    provider: adapter.mode,
    channelMessageId: opts.channelMessageId,
    imageFileIds: opts.imageFileIds,
    targets: targets.map((t) => ({
      zaloUserId: t.zaloUserId,
      displayName: t.displayName,
      threadKind: t.threadKind,
    })),
  });

  logger.info(
    {
      count: targets.length,
      jobId: parentId,
      photos: opts.imageFileIds?.length ?? 0,
    },
    'Broadcasting channel post to Zalo customers',
  );

  try {
    const result = await drainBroadcastItems(adapter, opts.api, parentId);
    if (opts.report !== false) {
      await reportBroadcast(result);
    }
    return result;
  } finally {
    if (opts.imageFileIds?.length) {
      photoCache.delete(photoCacheKey(opts.imageFileIds));
    }
  }
}

export async function retryBroadcast(
  adapter: ZaloAdapter,
  api: Api,
  parentId: number,
): Promise<BroadcastResult | null> {
  const parent = getJob(parentId);
  if (!parent || parent.type !== 'broadcast') return null;

  const n = requeueFailedBroadcastItems(parentId);
  if (n === 0) {
    const failed = listFailedBroadcastItems(parentId);
    const summary = finalizeBroadcastParent(parentId);
    return { ...summary, jobId: parentId, failedUserIds: failed.map((j) => {
      try {
        return (JSON.parse(j.payload) as BroadcastItemPayload).zaloUserId;
      } catch {
        return '?';
      }
    }) };
  }

  logger.info({ parentId, requeued: n }, 'Requeued failed broadcast items');
  return drainBroadcastItems(adapter, api, parentId);
}

export async function drainBroadcastItems(
  adapter: ZaloAdapter,
  api: Api,
  parentId?: number,
): Promise<BroadcastResult> {
  let lastParent = parentId ?? 0;
  let guard = 0;

  for (;;) {
    const job = claimNextBroadcastItem(parentId);
    if (!job) {
      const waitMs = msUntilNextPendingItem(parentId);
      if (waitMs == null) break;
      await sleep(Math.min(waitMs + 5, 5_000));
      continue;
    }
    lastParent = job.parentId ?? lastParent;
    guard += 1;
    if (guard > 10_000) break;

    let payload: BroadcastItemPayload;
    try {
      payload = JSON.parse(job.payload) as BroadcastItemPayload;
    } catch (err) {
      markJobFailedOrRetry(job.id, `Invalid payload: ${String(err)}`);
      continue;
    }

    if (payload.provider !== adapter.mode) {
      markJobFailedOrRetry(job.id, `Provider mismatch: ${payload.provider} vs ${adapter.mode}`);
      continue;
    }

    try {
      let zaloResult: ZaloSendResult;
      if (payload.imageFileIds && payload.imageFileIds.length > 0) {
        if (!adapter.sendImages) {
          throw new Error('Adapter không hỗ trợ gửi ảnh');
        }
        const key = photoCacheKey(payload.imageFileIds);
        let images = photoCache.get(key);
        if (!images) {
          images = await downloadTelegramFileIds(payload.imageFileIds);
          photoCache.set(key, images);
        }
        zaloResult = await adapter.sendImages(payload.zaloUserId, images, {
          threadKind: payload.threadKind ?? 'user',
          caption: payload.text || undefined,
        });
      } else {
        zaloResult = await adapter.sendText(payload.zaloUserId, payload.text, {
          threadKind: payload.threadKind ?? 'user',
        });
      }
      markJobDone(job.id);

      // Mirror vào topic + map t2z để /del thu hồi Zalo (best-effort)
      await mirrorBroadcastToTopic(api, adapter, payload, zaloResult).catch((err) => {
        logger.warn(
          { err, zaloUserId: payload.zaloUserId, jobId: job.id },
          'Broadcast mirrored to topic failed (Zalo already sent)',
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = markJobFailedOrRetry(job.id, message);
      logger.error(
        { err, zaloUserId: payload.zaloUserId, jobId: job.id, outcome },
        'Broadcast send failed for customer',
      );
    }
  }

  const summary = lastParent
    ? finalizeBroadcastParent(lastParent)
    : { ok: 0, fail: 0, failedUserIds: [] as string[] };

  logger.info({ ...summary, jobId: lastParent }, 'Broadcast finished');
  return { ...summary, jobId: lastParent };
}

/**
 * Gửi bản sao broadcast vào topic khách + lưu message_links (t2z).
 * Reply /del trên tin này → thu hồi Zalo.
 */
async function mirrorBroadcastToTopic(
  api: Api,
  adapter: ZaloAdapter,
  payload: BroadcastItemPayload,
  zaloResult: ZaloSendResult,
): Promise<void> {
  const customer = findByZaloUserId(payload.zaloUserId, adapter.mode);
  if (!customer || customer.topicMissing) {
    logger.warn(
      { zaloUserId: payload.zaloUserId },
      'Broadcast mirror skipped — no topic',
    );
    return;
  }

  const env = getEnv();
  const chatId = env.telegramForumGroupId;
  const topicId = customer.telegramTopicId;
  const body = (payload.text ?? '').trim();
  const fileIds = payload.imageFileIds ?? [];

  let telegramMessageId: number;

  if (fileIds.length > 0) {
    if (fileIds.length === 1) {
      const sent = await api.sendPhoto(chatId, fileIds[0]!, {
        message_thread_id: topicId,
        caption: body || undefined,
      });
      telegramMessageId = sent.message_id;
    } else {
      const media = fileIds.map((fileId, i) => ({
        type: 'photo' as const,
        media: fileId,
        ...(i === 0 && body ? { caption: body } : {}),
      }));
      const sent = await api.sendMediaGroup(chatId, media, {
        message_thread_id: topicId,
      });
      const first = sent[0];
      if (!first) throw new Error('sendMediaGroup returned empty');
      telegramMessageId = first.message_id;
    }
  } else {
    const sent = await api.sendMessage(chatId, body || '📣 (broadcast trống)', {
      message_thread_id: topicId,
    });
    telegramMessageId = sent.message_id;
  }

  const zaloMsgId = zaloResult.messageId;
  if (!zaloMsgId || zaloMsgId === 'ok' || zaloMsgId === '0') {
    logger.warn(
      { zaloUserId: payload.zaloUserId, telegramMessageId, zaloMsgId },
      'Broadcast mirrored to topic but Zalo msgId missing — /del sẽ không thu hồi được',
    );
    return;
  }

  upsertMessageLink({
    provider: adapter.mode,
    direction: 't2z',
    zaloMsgId,
    zaloCliMsgId: zaloResult.cliMsgId ?? null,
    zaloThreadId: payload.zaloUserId,
    threadKind: payload.threadKind ?? customer.threadKind,
    telegramChatId: chatId,
    telegramMessageId,
    telegramTopicId: topicId,
    bodyText: body || null,
  });

  logger.info(
    {
      zaloUserId: payload.zaloUserId,
      topicId,
      telegramMessageId,
      zaloMsgId,
      hasCli: Boolean(zaloResult.cliMsgId),
    },
    'Broadcast mirrored to Telegram topic',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function resumePendingBroadcasts(
  adapter: ZaloAdapter,
  api: Api,
): Promise<void> {
  const recovered = recoverStuckJobs();
  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered stuck broadcast jobs after restart');
  }
  const result = await drainBroadcastItems(adapter, api);
  if (result.ok + result.fail > 0) {
    await reportBroadcast(result);
  }
}

async function reportBroadcast(result: BroadcastResult): Promise<void> {
  const failPreview = result.failedUserIds.slice(0, 10).join(', ');
  const extra =
    result.failedUserIds.length > 10
      ? ` …(+${result.failedUserIds.length - 10})`
      : '';
  const lines = [
    `📣 Broadcast #${result.jobId}`,
    `ok=${result.ok} fail=${result.fail}`,
  ];
  if (result.fail > 0) {
    lines.push(`fail ids: ${failPreview}${extra}`);
    lines.push(`Gửi lại: /retrybroadcast ${result.jobId}`);
  }
  await notifyAdmins(lines.join('\n'));
}

async function downloadTelegramFileIds(fileIds: string[]): Promise<ZaloImageAttachment[]> {
  const env = getEnv();
  const out: ZaloImageAttachment[] = [];
  for (let i = 0; i < fileIds.length; i++) {
    const metaUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileIds[i]!)}`;
    const metaBuf = await downloadToBuffer(metaUrl, { timeoutMs: 45_000, retries: 3 });
    const meta = JSON.parse(metaBuf.toString('utf8')) as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (!meta.ok || !meta.result?.file_path) {
      throw new Error(`getFile failed: ${meta.description ?? 'unknown'}`);
    }
    const url = await telegramFileUrl(env.TELEGRAM_BOT_TOKEN, meta.result.file_path);
    const buf = await downloadToBuffer(url, { timeoutMs: 60_000, retries: 3 });
    const ext = meta.result.file_path.includes('.')
      ? meta.result.file_path.split('.').pop() || 'jpg'
      : 'jpg';
    out.push(bufferToZaloImage(buf, `broadcast-${i + 1}.${ext}`));
  }
  return out;
}
