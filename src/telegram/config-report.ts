import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import type { ZaloAdapter } from '../zalo/types.js';

export function maskSecret(value: string | undefined, keepStart = 4, keepEnd = 4): string {
  if (!value) return '(empty)';
  if (value.length <= keepStart + keepEnd) return '***';
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

async function checkChat(
  api: Api,
  label: string,
  chatId: number,
  botId: number,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const chat = await api.getChat(chatId);
    const title = 'title' in chat ? chat.title : undefined;
    const forum = 'is_forum' in chat ? Boolean(chat.is_forum) : false;
    lines.push(
      `${label}: ok id=${chat.id} type=${chat.type}` +
        (title ? ` title=${title}` : '') +
        (forum ? ' forum=yes' : ''),
    );
    try {
      const member = await api.getChatMember(chatId, botId);
      const status = member.status;
      const okAdmin =
        status === 'administrator' || status === 'creator';
      lines.push(
        `  bot member: ${status}${okAdmin ? ' ✓' : ' ⚠ cần admin (+ Manage Topics nếu forum)'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`  bot member: lỗi — ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`${label}: LỖI id=${chatId} — ${msg}`);
  }
  return lines;
}

/**
 * Báo cáo cấu hình .env (che secret) + kiểm tra live forum/channel với Telegram API.
 */
export async function buildConfigReport(
  api: Api,
  adapter: ZaloAdapter,
): Promise<string> {
  const env = getEnv();
  const me = await api.getMe();

  const lines: string[] = [
    '=== Cấu hình bridge ===',
    `bot: @${me.username ?? '—'} id=${me.id}`,
    `ZALO_MODE: ${adapter.mode} (env=${env.ZALO_MODE})`,
    `TELEGRAM_FORUM_GROUP_ID: ${env.telegramForumGroupId}`,
    `TELEGRAM_CHANNEL_ID: ${env.telegramChannelIds.join(',')} (${env.telegramChannelIds.length})`,
    `TELEGRAM_ADMIN_IDS: ${env.telegramAdminIds.join(',')} (${env.telegramAdminIds.length})`,
    `TELEGRAM_BOT_TOKEN: ${maskSecret(env.TELEGRAM_BOT_TOKEN, 8, 4)}`,
    `DATABASE_PATH: ${env.DATABASE_PATH}`,
    `LOG_LEVEL: ${env.LOG_LEVEL}`,
    `PORT: ${env.PORT}`,
    `LIST_PAGE_SIZE: ${env.LIST_PAGE_SIZE}`,
    `JOB_MAX_RETRIES: ${env.JOB_MAX_RETRIES}`,
    `ZALO_MIN_SEND_INTERVAL_MS: ${env.ZALO_MIN_SEND_INTERVAL_MS}`,
    `ZALO_SEND_MAX_PER_MINUTE: ${env.ZALO_SEND_MAX_PER_MINUTE}`,
  ];

  if (env.ZALO_MODE === 'personal') {
    lines.push(`ZALO_SESSION_PATH: ${env.ZALO_SESSION_PATH}`);
  } else {
    lines.push(
      `ZALO_BOT_TOKEN: ${maskSecret(env.ZALO_BOT_TOKEN)}`,
      `zaloBotTransport: ${env.zaloBotTransport}`,
      `ZALO_BOT_WEBHOOK_PATH: ${env.ZALO_BOT_WEBHOOK_PATH}`,
      `ZALO_BOT_WEBHOOK_SECRET: ${maskSecret(env.ZALO_BOT_WEBHOOK_SECRET)}`,
      `ZALO_BOT_POLL_TIMEOUT_SEC: ${env.ZALO_BOT_POLL_TIMEOUT_SEC}`,
    );
  }

  lines.push('', '=== Kiểm tra Telegram ===');
  lines.push(...(await checkChat(api, 'forum', env.telegramForumGroupId, me.id)));
  for (let i = 0; i < env.telegramChannelIds.length; i++) {
    const label =
      env.telegramChannelIds.length === 1 ? 'channel' : `channel[${i + 1}]`;
    lines.push(...(await checkChat(api, label, env.telegramChannelIds[i]!, me.id)));
  }

  return lines.join('\n');
}
