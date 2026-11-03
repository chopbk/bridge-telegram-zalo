import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const baseSchema = z.object({
  ZALO_MODE: z.enum(['bot', 'personal']),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_FORUM_GROUP_ID: z.string().min(1),
  /** Một hoặc nhiều channel id, cách nhau bởi dấu phẩy */
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  /** Một hoặc nhiều admin user id, cách nhau bởi dấu phẩy */
  TELEGRAM_ADMIN_IDS: z.string().min(1, 'TELEGRAM_ADMIN_IDS is required'),
  DATABASE_PATH: z.string().default('./data/bridge.db'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().positive().default(3080),
  ZALO_BOT_TOKEN: z.string().optional(),
  ZALO_BOT_TRANSPORT: z.enum(['polling', 'webhook']).optional(),
  ZALO_BOT_WEBHOOK_PATH: z.string().default('/webhooks/zalo'),
  ZALO_BOT_WEBHOOK_SECRET: z.string().optional(),
  ZALO_BOT_POLL_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  ZALO_SESSION_PATH: z.string().default('./data/zalo-session.json'),
  ZALO_MIN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1500),
  ZALO_SEND_MAX_PER_MINUTE: z.coerce.number().int().nonnegative().default(20),
  JOB_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  LIST_PAGE_SIZE: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof baseSchema> & {
  telegramAdminIds: number[];
  telegramForumGroupId: number;
  /** Tất cả channel được lắng nghe broadcast */
  telegramChannelIds: number[];
  /** Channel đầu tiên (tương thích cũ) */
  telegramChannelId: number;
  zaloBotTransport: 'polling' | 'webhook';
};

let cached: Env | null = null;

/** Parse danh sách id số: `1,2, 3` hoặc xuống dòng / `;` */
export function parseIdList(raw: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isFinite(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = baseSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid env: ${msg}`);
  }

  const data = parsed.data;
  const telegramAdminIds = parseIdList(data.TELEGRAM_ADMIN_IDS);
  if (telegramAdminIds.length === 0) {
    throw new Error('TELEGRAM_ADMIN_IDS must list at least one numeric Telegram user id');
  }

  if (data.ZALO_MODE === 'bot' && !data.ZALO_BOT_TOKEN) {
    throw new Error('ZALO_MODE=bot requires ZALO_BOT_TOKEN');
  }

  if (
    data.ZALO_MODE === 'bot' &&
    (data.ZALO_BOT_TRANSPORT === 'webhook' ||
      (!data.ZALO_BOT_TRANSPORT && process.env.NODE_ENV === 'production')) &&
    !data.ZALO_BOT_WEBHOOK_SECRET
  ) {
    throw new Error('Webhook transport requires ZALO_BOT_WEBHOOK_SECRET');
  }

  const forumId = Number(data.TELEGRAM_FORUM_GROUP_ID);
  if (!Number.isFinite(forumId)) {
    throw new Error('TELEGRAM_FORUM_GROUP_ID must be a number');
  }

  const telegramChannelIds = parseIdList(data.TELEGRAM_CHANNEL_ID);
  if (telegramChannelIds.length === 0) {
    throw new Error(
      'TELEGRAM_CHANNEL_ID must list at least one numeric channel id (comma-separated OK)',
    );
  }

  const zaloBotTransport =
    data.ZALO_BOT_TRANSPORT ??
    (process.env.NODE_ENV === 'production' ? 'webhook' : 'polling');

  cached = {
    ...data,
    telegramAdminIds,
    telegramForumGroupId: forumId,
    telegramChannelIds,
    telegramChannelId: telegramChannelIds[0]!,
    zaloBotTransport,
  };
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
