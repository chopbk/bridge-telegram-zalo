import type { Express, Request, Response } from 'express';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import type { NormalizedInbound, ZaloAdapter, ZaloSendResult } from '../types.js';

type InboundHandler = (msg: NormalizedInbound) => void | Promise<void>;

/**
 * Official Zalo Bot API adapter.
 * Docs: https://docs.zaloplatforms.com/zalo-bot
 */
export class ZaloBotAdapter implements ZaloAdapter {
  readonly mode = 'bot' as const;
  private handler: InboundHandler | null = null;
  private readonly queue: SendQueue;
  private readonly apiBase: string;

  constructor() {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS);
    this.apiBase = `https://bot-api.zaloplatforms.com/bot${env.ZALO_BOT_TOKEN}`;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    logger.info({ mode: this.mode }, 'ZaloBotAdapter ready (webhook via Express)');
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  /** Mount webhook route on Express app */
  mountWebhook(app: Express): void {
    const path = getEnv().ZALO_BOT_WEBHOOK_PATH;
    app.post(path, (req: Request, res: Response) => {
      res.sendStatus(200);
      void this.handleWebhook(req.body).catch((err) => {
        logger.error({ err }, 'Zalo bot webhook handler failed');
      });
    });
    logger.info({ path }, 'Zalo bot webhook mounted');
  }

  private async handleWebhook(body: unknown): Promise<void> {
    const msg = normalizeBotUpdate(body);
    if (!msg || !this.handler) return;
    await this.handler(msg);
  }

  sendText(userId: string, text: string): Promise<ZaloSendResult> {
    return this.queue.enqueue(async () => {
      const res = await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        result?: { message_id?: string | number };
        description?: string;
        error_code?: number;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(
          `Zalo Bot sendMessage failed: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
        );
      }
      return {
        messageId: String(json.result?.message_id ?? 'ok'),
      };
    });
  }
}

export function normalizeBotUpdate(body: unknown): NormalizedInbound | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  // Zalo Bot style (Telegram-like): message.chat.id + message.text
  const message = raw.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    const chat = message.chat as Record<string, unknown> | undefined;
    const text = typeof message.text === 'string' ? message.text : null;
    const chatId = chat?.id;
    if (text && (typeof chatId === 'string' || typeof chatId === 'number')) {
      const from = message.from as Record<string, unknown> | undefined;
      const name =
        typeof from?.display_name === 'string'
          ? from.display_name
          : typeof from?.first_name === 'string'
            ? from.first_name
            : undefined;
      return {
        zaloUserId: String(chatId),
        text,
        displayName: name,
        messageId: message.message_id != null ? String(message.message_id) : undefined,
      };
    }
  }

  // OA-style fallback: event_name user_send_text
  if (raw.event_name === 'user_send_text') {
    const sender = raw.sender as Record<string, unknown> | undefined;
    const msg = raw.message as Record<string, unknown> | undefined;
    const text = typeof msg?.text === 'string' ? msg.text : null;
    const id = sender?.id;
    if (text && (typeof id === 'string' || typeof id === 'number')) {
      return {
        zaloUserId: String(id),
        text,
        messageId: msg?.msg_id != null ? String(msg.msg_id) : undefined,
      };
    }
  }

  return null;
}
