import type { Express, Request, Response } from 'express';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import type { NormalizedInbound, ZaloAdapter, ZaloSendResult } from '../types.js';

type InboundHandler = (msg: NormalizedInbound) => void | Promise<void>;

/**
 * Official Zalo Bot API adapter.
 * Docs: https://docs.zaloplatforms.com/zalo-bot
 *
 * - Local/dev: long polling via getUpdates (default when NODE_ENV !== production)
 * - Production: HTTPS webhook
 * Polling and webhook are mutually exclusive on Zalo's side.
 */
export class ZaloBotAdapter implements ZaloAdapter {
  readonly mode = 'bot' as const;
  private handler: InboundHandler | null = null;
  private readonly queue: SendQueue;
  private readonly apiBase: string;
  private pollAbort = false;
  private pollPromise: Promise<void> | null = null;

  constructor() {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS);
    this.apiBase = `https://bot-api.zaloplatforms.com/bot${env.ZALO_BOT_TOKEN}`;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const transport = getEnv().zaloBotTransport;
    if (transport === 'polling') {
      await this.deleteWebhook();
      this.pollAbort = false;
      this.pollPromise = this.pollLoop();
      logger.info({ mode: this.mode, transport }, 'ZaloBotAdapter started (long polling)');
      return;
    }
    logger.info({ mode: this.mode, transport }, 'ZaloBotAdapter ready (webhook via Express)');
  }

  async stop(): Promise<void> {
    this.pollAbort = true;
    if (this.pollPromise) {
      await this.pollPromise.catch(() => undefined);
      this.pollPromise = null;
    }
    this.handler = null;
  }

  /** Mount webhook route — only call when transport=webhook */
  mountWebhook(app: Express): void {
    const path = getEnv().ZALO_BOT_WEBHOOK_PATH;
    app.post(path, (req: Request, res: Response) => {
      res.sendStatus(200);
      void this.dispatchInbound(req.body).catch((err) => {
        logger.error({ err }, 'Zalo bot webhook handler failed');
      });
    });
    logger.info({ path }, 'Zalo bot webhook mounted');
  }

  private async deleteWebhook(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json()) as { ok?: boolean; description?: string };
      logger.info({ ok: json.ok, description: json.description }, 'Zalo deleteWebhook');
    } catch (err) {
      logger.warn({ err }, 'Zalo deleteWebhook failed — continuing with polling');
    }
  }

  private async pollLoop(): Promise<void> {
    const timeout = getEnv().ZALO_BOT_POLL_TIMEOUT_SEC;
    while (!this.pollAbort) {
      try {
        const res = await fetch(`${this.apiBase}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: String(timeout) }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          result?: unknown;
          description?: string;
        };
        if (!res.ok || json.ok === false) {
          logger.warn(
            { status: res.status, description: json.description },
            'Zalo getUpdates non-OK',
          );
          await sleep(2000);
          continue;
        }
        if (json.result == null) continue;

        const updates = Array.isArray(json.result) ? json.result : [json.result];
        for (const update of updates) {
          if (this.pollAbort) break;
          await this.dispatchInbound(update);
        }
      } catch (err) {
        if (this.pollAbort) break;
        logger.error({ err }, 'Zalo getUpdates poll error');
        await sleep(2000);
      }
    }
  }

  private async dispatchInbound(body: unknown): Promise<void> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeBotUpdate(body: unknown): NormalizedInbound | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  // Zalo Bot style (Telegram-like / getUpdates): message.chat.id + message.text
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
