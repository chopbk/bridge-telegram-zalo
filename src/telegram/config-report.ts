import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import type { ZaloAdapter } from '../zalo/types.js';

export function maskSecret(value: string | undefined, keepStart = 4, keepEnd = 4): string {
  if (!value) return '(empty)';
  if (value.length <= keepStart + keepEnd) return '***';
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

function shortTgError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/Bad Request:\s*(.+?)\)?\s*$/i) ?? raw.match(/:\s*(.+)$/);
  const detail = (m?.[1] ?? raw).replace(/\)$/, '').trim();
  return detail.length > 80 ? `${detail.slice(0, 77)}…` : detail;
}

function kv(label: string, value: string | number): string {
  return `${label.padEnd(14)} ${value}`;
}

async function checkChat(
  api: Api,
  label: string,
  chatId: number,
  botId: number,
): Promise<string[]> {
  const head = `▸ ${label}`;
  try {
    const chat = await api.getChat(chatId);
    const title = 'title' in chat && chat.title ? String(chat.title) : '—';
    const kind =
      chat.type === 'channel'
        ? 'channel'
        : 'is_forum' in chat && chat.is_forum
          ? 'forum'
          : chat.type;

    let botLine = 'bot: ?';
    try {
      const member = await api.getChatMember(chatId, botId);
      const status = member.status;
      const okAdmin = status === 'administrator' || status === 'creator';
      botLine = okAdmin
        ? `bot: ${status} ✓`
        : `bot: ${status} ⚠ cần admin` +
          (kind === 'forum' ? ' + Manage Topics' : '');
    } catch (err) {
      botLine = `bot: lỗi — ${shortTgError(err)}`;
    }

    return [
      head,
      `  ${title}`,
      `  id ${chat.id} · ${kind}`,
      `  ${botLine}`,
    ];
  } catch (err) {
    return [
      head,
      `  id ${chatId}`,
      `  ✗ ${shortTgError(err)}`,
    ];
  }
}

/**
 * Báo cáo cấu hình .env (che secret) + kiểm tra live forum/channel.
 */
export async function buildConfigReport(
  api: Api,
  adapter: ZaloAdapter,
): Promise<string> {
  const env = getEnv();
  const me = await api.getMe();
  const lines: string[] = [];

  lines.push(
    '── Bridge ──',
    kv('Bot', `@${me.username ?? '—'} (${me.id})`),
    kv('Mode', `${adapter.mode}`),
    kv('DB', env.DATABASE_PATH),
    kv('Log', env.LOG_LEVEL),
    kv('Port', env.PORT),
  );

  lines.push(
    '',
    '── Telegram ──',
    kv('Forum', String(env.telegramForumGroupId)),
    kv(
      'Channels',
      env.telegramChannelIds.length
        ? env.telegramChannelIds.map(String).join('\n' + ' '.repeat(15))
        : '(none)',
    ),
    kv('Admins', env.telegramAdminIds.join(', ')),
    kv('Token', maskSecret(env.TELEGRAM_BOT_TOKEN, 8, 4)),
  );

  lines.push(
    '',
    '── Rate limit ──',
    kv('Interval', `${env.ZALO_MIN_SEND_INTERVAL_MS} ms`),
    kv('Max/min', String(env.ZALO_SEND_MAX_PER_MINUTE)),
    kv('Job retry', String(env.JOB_MAX_RETRIES)),
    kv('List page', String(env.LIST_PAGE_SIZE)),
  );

  if (env.ZALO_MODE === 'personal') {
    lines.push('', '── Zalo personal ──', kv('Session', env.ZALO_SESSION_PATH));
  } else {
    lines.push(
      '',
      '── Zalo bot ──',
      kv('Token', maskSecret(env.ZALO_BOT_TOKEN)),
      kv('Transport', env.zaloBotTransport),
      kv('Webhook', env.ZALO_BOT_WEBHOOK_PATH),
      kv('Secret', maskSecret(env.ZALO_BOT_WEBHOOK_SECRET)),
      kv('Poll sec', env.ZALO_BOT_POLL_TIMEOUT_SEC),
    );
  }

  lines.push('', '── Kiểm tra live ──');
  lines.push(...(await checkChat(api, 'Forum', env.telegramForumGroupId, me.id)));
  for (let i = 0; i < env.telegramChannelIds.length; i++) {
    const label =
      env.telegramChannelIds.length === 1 ? 'Channel' : `Channel ${i + 1}`;
    lines.push(...(await checkChat(api, label, env.telegramChannelIds[i]!, me.id)));
  }

  return lines.join('\n');
}
