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
  const targets = broadcastTargets(adapter.mode);
  const { parentId } = createBroadcastJob({
    text,
    provider: adapter.mode,
    channelMessageId: opts?.channelMessageId,
    targets: targets.map((t) => ({
      zaloUserId: t.zaloUserId,
      displayName: t.displayName,
    })),
  });

  logger.info(
    { count: targets.length, jobId: parentId },
    'Broadcasting channel post to Zalo customers',
  );

  const result = await drainBroadcastItems(adapter, parentId);

  if (opts?.report !== false) {
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
      await adapter.sendText(payload.zaloUserId, payload.text);
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
    lines.push(`Gửi lại: /retry_broadcast ${result.jobId}`);
  }
  await notifyAdmins(lines.join('\n'));
}
