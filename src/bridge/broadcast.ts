import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
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
import { notifyAdmins } from '../telegram/notify.js';
import type { ZaloAdapter } from '../zalo/types.js';
import { bufferToZaloImage, downloadToBuffer, telegramFileUrl } from './media.js';
import { broadcastTargets } from './mapper.js';

export type BroadcastResult = {
  ok: number;
  fail: number;
  jobId: number;
  failedUserIds: string[];
};

/**
 * Luồng C: Telegram channel → fan-out Zalo (persisted jobs + retry)
 */
export async function broadcastChannelText(
  adapter: ZaloAdapter,
  text: string,
  opts?: { channelMessageId?: number; report?: boolean },
): Promise<BroadcastResult> {
  return enqueueAndDrainBroadcast(adapter, {
    text,
    channelMessageId: opts?.channelMessageId,
    report: opts?.report,
  });
}

/** Broadcast ảnh channel (file_id Telegram — tải lại lúc gửi từng khách). */
export async function broadcastChannelPhotos(
  adapter: ZaloAdapter,
  imageFileIds: string[],
  opts?: { caption?: string; channelMessageId?: number; report?: boolean },
): Promise<BroadcastResult> {
  if (!imageFileIds.length) {
    throw new Error('broadcastChannelPhotos: empty imageFileIds');
  }
  return enqueueAndDrainBroadcast(adapter, {
    text: (opts?.caption ?? '').trim(),
    imageFileIds,
    channelMessageId: opts?.channelMessageId,
    report: opts?.report,
  });
}

async function enqueueAndDrainBroadcast(
  adapter: ZaloAdapter,
  opts: {
    text: string;
    imageFileIds?: string[];
    channelMessageId?: number;
    report?: boolean;
  },
): Promise<BroadcastResult> {
  const targets = broadcastTargets(adapter.mode);
  const { parentId } = createBroadcastJob({
    text: opts.text,
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

  const result = await drainBroadcastItems(adapter, parentId);

  if (opts.report !== false) {
    await reportBroadcast(result);
  }

  return result;
}

export async function retryBroadcast(
  adapter: ZaloAdapter,
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
  return drainBroadcastItems(adapter, parentId);
}

export async function drainBroadcastItems(
  adapter: ZaloAdapter,
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
      if (payload.imageFileIds && payload.imageFileIds.length > 0) {
        if (!adapter.sendImages) {
          throw new Error('Adapter không hỗ trợ gửi ảnh');
        }
        const images = await downloadTelegramFileIds(payload.imageFileIds);
        await adapter.sendImages(payload.zaloUserId, images, {
          threadKind: payload.threadKind ?? 'user',
          caption: payload.text || undefined,
        });
      } else {
        await adapter.sendText(payload.zaloUserId, payload.text, {
          threadKind: payload.threadKind ?? 'user',
        });
      }
      markJobDone(job.id);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function resumePendingBroadcasts(adapter: ZaloAdapter): Promise<void> {
  const recovered = recoverStuckJobs();
  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered stuck broadcast jobs after restart');
  }
  const result = await drainBroadcastItems(adapter);
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

async function downloadTelegramFileIds(fileIds: string[]) {
  const env = getEnv();
  // Lazy import Api via getFile through raw Telegram HTTP to avoid needing Bot ctx here
  const out = [];
  for (let i = 0; i < fileIds.length; i++) {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileIds[i]!)}`,
    );
    const meta = (await metaRes.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (!meta.ok || !meta.result?.file_path) {
      throw new Error(`getFile failed: ${meta.description ?? metaRes.status}`);
    }
    const url = await telegramFileUrl(env.TELEGRAM_BOT_TOKEN, meta.result.file_path);
    const buf = await downloadToBuffer(url);
    const ext = meta.result.file_path.includes('.')
      ? meta.result.file_path.split('.').pop() || 'jpg'
      : 'jpg';
    out.push(bufferToZaloImage(buf, `broadcast-${i + 1}.${ext}`));
  }
  return out;
}
