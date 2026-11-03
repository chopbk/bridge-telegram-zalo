import type { Express, Request, Response } from 'express';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import {
  markInboundEventDone,
  markInboundEventFailed,
  storeInboundEvent,
} from '../../db/inbound-events.js';
import type {
  NormalizedInbound,
  SendTextOptions,
  ZaloAdapter,
  ZaloSendResult,
} from '../types.js';

type InboundHandler = (msg: NormalizedInbound) => void | Promise<void>;

/**
 * Official Zalo Bot API adapter.
 * Docs: https://docs.zaloplatforms.com/zalo-bot
 *
 * - Local/dev: long polling via getUpdates
 * - Production: HTTPS webhook (secret required; persist before 200)
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
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS, env.ZALO_SEND_MAX_PER_MINUTE);
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
      if (!this.verifyWebhook(req)) {
        res.sendStatus(401);
        return;
      }

      const msg = normalizeBotUpdate(req.body);
      const rawId = extractRawUpdateId(req.body);
      const eventId = msg?.messageId ?? (rawId ? `raw:${rawId}` : null);

      if (!eventId) {
        res.sendStatus(200);
        return;
      }

      // Persist before ack so restart can recover
      const stored = storeInboundEvent(this.mode, eventId, req.body);
      res.sendStatus(200);
      if (!stored) return;

      void this.dispatchInbound(req.body, msg)
        .then(() => markInboundEventDone(this.mode, eventId))
        .catch((err) => {
          markInboundEventFailed(this.mode, eventId);
          logger.error({ err }, 'Zalo bot webhook handler failed');
        });
    });
    logger.info({ path }, 'Zalo bot webhook mounted');
  }

  private verifyWebhook(req: Request): boolean {
    const secret = getEnv().ZALO_BOT_WEBHOOK_SECRET;
    if (!secret) return false;
    const header =
      req.get('X-Zalo-Bot-Api-Secret-Token') ||
      req.get('x-zalo-bot-api-secret-token') ||
      '';
    if (header && header === secret) return true;
    const auth = req.get('authorization') || '';
    if (auth === `Bearer ${secret}` || auth === secret) return true;
    logger.warn('Zalo bot webhook rejected — invalid secret');
    return false;
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

  private async dispatchInbound(body: unknown, preNormalized?: NormalizedInbound | null): Promise<void> {
    const msg = preNormalized === undefined ? normalizeBotUpdate(body) : preNormalized;
    if (!msg || !this.handler) {
      if (!msg && body) {
        logger.info({ bodyType: typeof body }, 'Unsupported Zalo bot update — skipped');
      }
      return;
    }

    // Dedup lives in bridge/inbound (claimProcessedMessage)
    await this.handler(msg);
  }

  sendText(userId: string, text: string, _opts?: SendTextOptions): Promise<ZaloSendResult> {
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

function extractRawUpdateId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (raw.update_id != null) return String(raw.update_id);
  if (raw.event_id != null) return String(raw.event_id);
  return null;
}

export function normalizeBotUpdate(body: unknown): NormalizedInbound | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  const message = raw.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    const chat = message.chat as Record<string, unknown> | undefined;
    const chatId = chat?.id;
    if (typeof chatId === 'string' || typeof chatId === 'number') {
      const from = message.from as Record<string, unknown> | undefined;
      const name =
        typeof from?.display_name === 'string'
          ? from.display_name
          : typeof from?.first_name === 'string'
            ? from.first_name
            : undefined;
      const messageId = message.message_id != null ? String(message.message_id) : undefined;

      if (typeof message.text === 'string' && message.text) {
        return {
          zaloUserId: String(chatId),
          text: message.text,
          displayName: name,
          messageId,
        };
      }

      // Non-text message types
      const kind =
        message.photo != null
          ? 'photo'
          : message.document != null
            ? 'document'
            : message.voice != null
              ? 'voice'
              : message.sticker != null
                ? 'sticker'
                : message.video != null
                  ? 'video'
                  : 'media';
      return {
        zaloUserId: String(chatId),
        text: '',
        displayName: name,
        messageId,
        unsupportedKind: kind,
      };
    }
  }

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
