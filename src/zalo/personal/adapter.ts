import { ThreadType, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import { notifyAdmins } from '../../telegram/notify.js';
import { getZaloApi, resetZaloClient } from './session.js';
import type { NormalizedInbound, ZaloAdapter, ZaloSendResult } from '../types.js';

type InboundHandler = (msg: NormalizedInbound) => void | Promise<void>;

export class ZaloPersonalAdapter implements ZaloAdapter {
  readonly mode = 'personal' as const;
  private handler: InboundHandler | null = null;
  private readonly queue: SendQueue;
  private started = false;

  constructor() {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS, env.ZALO_SEND_MAX_PER_MINUTE);
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const api = await getZaloApi();
    api.listener.on('message', (message) => {
      void this.handleMessage(message).catch((err) => {
        logger.error({ err }, 'Personal Zalo inbound failed');
      });
    });
    api.listener.start();
    this.started = true;
    logger.info(
      {
        mode: this.mode,
        minIntervalMs: getEnv().ZALO_MIN_SEND_INTERVAL_MS,
        maxPerMinute: getEnv().ZALO_SEND_MAX_PER_MINUTE,
      },
      'ZaloPersonalAdapter listener started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      const api = await getZaloApi();
      api.listener.stop();
    } catch {
      // ignore
    }
    this.handler = null;
    this.started = false;
  }

  private async handleMessage(message: ZaloListenerMessage): Promise<void> {
    if (message.isSelf) return;
    if (message.type !== ThreadType.User) return;
    if (!this.handler) return;

    const content = message.data.content;
    const displayName =
      typeof message.data.dName === 'string' ? message.data.dName : undefined;
    const messageId =
      message.data.msgId != null ? String(message.data.msgId) : undefined;
    const zaloUserId = String(message.threadId);

    if (typeof content === 'string' && content.trim()) {
      await this.handler({
        zaloUserId,
        text: content,
        displayName,
        messageId,
      });
      return;
    }

    // Non-text: still surface to Telegram
    const kind = describeUnsupportedContent(content);
    await this.handler({
      zaloUserId,
      text: '',
      displayName,
      messageId,
      unsupportedKind: kind,
    });
  }

  sendText(userId: string, text: string): Promise<ZaloSendResult> {
    return this.queue.enqueue(async () => {
      try {
        const api = await getZaloApi();
        const result = await api.sendMessage(text, userId, ThreadType.User);
        const messageId = result.message?.msgId;
        return {
          messageId: messageId !== undefined && messageId !== null ? String(messageId) : 'ok',
        };
      } catch (err) {
        resetZaloClient();
        logger.error({ err, userId }, 'Personal Zalo send failed');
        const message = err instanceof Error ? err.message : String(err);
        void notifyAdmins(`Zalo personal send failed for ${userId}: ${message}`);
        throw err;
      }
    });
  }
}

function describeUnsupportedContent(content: unknown): string {
  if (content == null) return 'empty';
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (obj.title || obj.href || obj.thumb) return 'link/attachment';
    if ('action' in obj) return 'action';
    return 'media/object';
  }
  return typeof content;
}
