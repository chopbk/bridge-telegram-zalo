import { Bot, type Context } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  allCustomers,
  blockByTopic,
  findCustomers,
  muteByTopic,
  pageCustomers,
  recreateTopicById,
  setStatusByTopic,
} from '../bridge/mapper.js';
import { forwardTopicToZalo } from '../bridge/outbound.js';
import { broadcastChannelText, retryBroadcast } from '../bridge/broadcast.js';
import { countByStatus } from '../db/customers.js';
import type { SubscriptionStatus } from '../db/client.js';
import type { ZaloAdapter } from '../zalo/types.js';

function isAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (id == null) return false;
  return getEnv().telegramAdminIds.includes(id);
}

function inForumGroup(ctx: Context): boolean {
  const chatId = ctx.chat?.id;
  return chatId === getEnv().telegramForumGroupId;
}

/** Admin commands only in forum group + admin ids */
async function requireAdminInForum(ctx: Context): Promise<boolean> {
  if (!inForumGroup(ctx)) return false;
  if (!isAdmin(ctx)) return false;
  return true;
}

function formatCustomerLine(c: {
  displayName: string | null;
  zaloUserId: string;
  telegramTopicId: number;
  provider: string;
  muted: boolean;
  blocked: boolean;
  subscriptionStatus: string;
}, index: number): string {
  const flags = [
    c.subscriptionStatus,
    c.muted ? 'muted' : null,
    c.blocked ? 'blocked' : null,
  ]
    .filter(Boolean)
    .join(',');
  return `${index}. ${c.displayName ?? c.zaloUserId} | topic=${c.telegramTopicId} | ${flags}`;
}

export function createTelegramBot(adapter: ZaloAdapter): Bot {
  const env = getEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('mode', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    await ctx.reply(`ZALO_MODE=${adapter.mode}`);
  });

  bot.command('status', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const customers = allCustomers(adapter.mode);
    const byStatus = countByStatus(adapter.mode);
    const targets = customers.filter(
      (c) =>
        c.subscriptionStatus === 'approved' && !c.muted && !c.blocked && !c.topicMissing,
    ).length;
    await ctx.reply(
      [
        `mode: ${adapter.mode}`,
        `customers: ${customers.length}`,
        `pending=${byStatus.pending} approved=${byStatus.approved} rejected=${byStatus.rejected} unsubscribed=${byStatus.unsubscribed}`,
        `broadcast targets: ${targets}`,
        `forum: ${env.telegramForumGroupId}`,
        `channel: ${env.telegramChannelId}`,
      ].join('\n'),
    );
  });

  bot.command('list', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);
    let page = 1;
    let status: SubscriptionStatus | undefined;
    for (const p of parts) {
      if (/^\d+$/.test(p)) page = Number(p);
      else if (['pending', 'approved', 'rejected', 'unsubscribed'].includes(p)) {
        status = p as SubscriptionStatus;
      }
    }

    const result = pageCustomers(adapter.mode, page, status);
    if (result.total === 0) {
      await ctx.reply('Chưa có khách nào.');
      return;
    }
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const lines = result.items.map((c, i) =>
      formatCustomerLine(c, (result.page - 1) * result.pageSize + i + 1),
    );
    const header = `Trang ${result.page}/${totalPages} (${result.total} khách)${status ? ` filter=${status}` : ''}`;
    const text = [header, ...lines].join('\n');
    await ctx.reply(text.length > 3900 ? text.slice(0, 3900) + '\n…' : text);
  });

  bot.command('search', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const q = ctx.match?.toString().trim() ?? '';
    if (!q) {
      await ctx.reply('Dùng: /search <tên hoặc zalo id>');
      return;
    }
    const found = findCustomers(adapter.mode, q);
    if (found.length === 0) {
      await ctx.reply('Không tìm thấy.');
      return;
    }
    const text = found.map((c, i) => formatCustomerLine(c, i + 1)).join('\n');
    await ctx.reply(text.length > 3900 ? text.slice(0, 3900) + '\n…' : text);
  });

  bot.command('approve', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /approve trong topic của khách.');
      return;
    }
    const customer = setStatusByTopic(topicId, adapter.mode, 'approved');
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã duyệt ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('reject', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /reject trong topic của khách.');
      return;
    }
    const customer = setStatusByTopic(topicId, adapter.mode, 'rejected');
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã từ chối ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('block', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /block trong topic của khách.');
      return;
    }
    const customer = blockByTopic(topicId, adapter.mode, true);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã block ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('unblock', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /unblock trong topic của khách.');
      return;
    }
    const customer = blockByTopic(topicId, adapter.mode, false);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã unblock ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('mute', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /mute trong topic của khách.');
      return;
    }
    const customer = muteByTopic(topicId, adapter.mode, true);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã mute broadcast ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('unmute', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /unmute trong topic của khách.');
      return;
    }
    const customer = muteByTopic(topicId, adapter.mode, false);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã unmute ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('recreate', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /recreate trong topic khách (hoặc topic cũ).');
      return;
    }
    try {
      const customer = await recreateTopicById(ctx.api, topicId, adapter.mode);
      if (!customer) {
        await ctx.reply('Không tìm thấy khách.');
        return;
      }
      await ctx.reply(`Đã tạo lại topic ${customer.telegramTopicId} cho ${customer.displayName ?? customer.zaloUserId}`);
    } catch (err) {
      logger.error({ err }, 'recreate topic failed');
      await ctx.reply('Tạo lại topic thất bại.');
    }
  });

  bot.command('retry_broadcast', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const idRaw = ctx.match?.toString().trim() ?? '';
    const jobId = Number(idRaw);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      await ctx.reply('Dùng: /retry_broadcast <jobId>');
      return;
    }
    try {
      const result = await retryBroadcast(adapter, jobId);
      if (!result) {
        await ctx.reply('Không tìm thấy broadcast job.');
        return;
      }
      await ctx.reply(
        `Retry #${result.jobId}: ok=${result.ok} fail=${result.fail}` +
          (result.fail > 0 ? `\nfail ids: ${result.failedUserIds.slice(0, 10).join(', ')}` : ''),
      );
    } catch (err) {
      logger.error({ err, jobId }, 'retry_broadcast failed');
      await ctx.reply('Retry thất bại. Xem log.');
    }
  });

  // Luồng B: tin trong forum topic — chỉ admin
  bot.on('message:text', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    if (msg.chat.id !== env.telegramForumGroupId) return;
    if (ctx.from?.is_bot) return;
    if (ctx.from?.id === ctx.me.id) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return;
    if (msg.text.startsWith('/')) return;

    if (!isAdmin(ctx)) {
      logger.info({ from: ctx.from?.id, topicId }, 'Non-admin message in topic ignored');
      return;
    }

    try {
      await forwardTopicToZalo(adapter, topicId, msg.text);
    } catch (err) {
      logger.error({ err, topicId }, 'Topic→Zalo failed');
      const detail = err instanceof Error ? err.message : 'Gửi Zalo thất bại.';
      await ctx.reply(detail).catch(() => undefined);
    }
  });

  // Luồng C: channel_post → broadcast
  bot.on('channel_post:text', async (ctx) => {
    const post = ctx.channelPost;
    if (!post || !('text' in post) || !post.text) return;
    if (post.chat.id !== env.telegramChannelId) return;

    try {
      const result = await broadcastChannelText(adapter, post.text, {
        channelMessageId: post.message_id,
      });
      logger.info({ result }, 'Channel broadcast done');
    } catch (err) {
      logger.error({ err }, 'Channel broadcast failed');
    }
  });

  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  return bot;
}

export async function startTelegramBot(bot: Bot): Promise<void> {
  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'Telegram bot started (polling)'),
  });
}
