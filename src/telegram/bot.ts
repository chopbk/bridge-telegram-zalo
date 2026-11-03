import { Bot, type Context } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { allCustomers, muteByTopic } from '../bridge/mapper.js';
import { forwardTopicToZalo } from '../bridge/outbound.js';
import { broadcastChannelText } from '../bridge/broadcast.js';
import type { ZaloAdapter } from '../zalo/types.js';

function isAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (id == null) return false;
  const admins = getEnv().telegramAdminIds;
  if (admins.length === 0) return true; // open if unset (dev convenience)
  return admins.includes(id);
}

export function createTelegramBot(adapter: ZaloAdapter): Bot {
  const env = getEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('mode', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply(`ZALO_MODE=${adapter.mode}`);
  });

  bot.command('status', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const customers = allCustomers();
    const active = customers.filter((c) => c.active && !c.muted).length;
    await ctx.reply(
      [
        `mode: ${adapter.mode}`,
        `customers: ${customers.length}`,
        `broadcast targets: ${active}`,
        `forum: ${env.telegramForumGroupId}`,
        `channel: ${env.telegramChannelId}`,
      ].join('\n'),
    );
  });

  bot.command('list', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const customers = allCustomers();
    if (customers.length === 0) {
      await ctx.reply('Chưa có khách nào.');
      return;
    }
    const lines = customers.map((c, i) => {
      const flags = [c.muted ? 'muted' : null, !c.active ? 'inactive' : null]
        .filter(Boolean)
        .join(',');
      return `${i + 1}. ${c.displayName ?? c.zaloUserId} | topic=${c.telegramTopicId} | ${c.provider}${flags ? ` | ${flags}` : ''}`;
    });
    const text = lines.join('\n');
    await ctx.reply(text.length > 3900 ? text.slice(0, 3900) + '\n…' : text);
  });

  bot.command('mute', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /mute trong topic của khách.');
      return;
    }
    const customer = muteByTopic(topicId, true);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã mute ${customer.displayName ?? customer.zaloUserId}`);
  });

  bot.command('unmute', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /unmute trong topic của khách.');
      return;
    }
    const customer = muteByTopic(topicId, false);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`Đã unmute ${customer.displayName ?? customer.zaloUserId}`);
  });

  // Luồng B: tin trong forum topic (không phải bot) → Zalo
  bot.on('message:text', async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    // Chỉ xử lý trong forum group
    if (msg.chat.id !== env.telegramForumGroupId) return;

    // Anti-loop: bỏ qua tin từ chính bot
    if (ctx.from?.is_bot) return;
    if (ctx.from?.id === ctx.me.id) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return; // General topic / không phải thread khách

    // Bỏ qua lệnh
    if (msg.text.startsWith('/')) return;

    try {
      await forwardTopicToZalo(adapter, topicId, msg.text);
    } catch (err) {
      logger.error({ err, topicId }, 'Topic→Zalo failed');
      await ctx.reply('Gửi Zalo thất bại. Xem log server.').catch(() => undefined);
    }
  });

  // Luồng C: channel_post → broadcast
  bot.on('channel_post:text', async (ctx) => {
    const post = ctx.channelPost;
    if (!post || !('text' in post) || !post.text) return;
    if (post.chat.id !== env.telegramChannelId) return;

    try {
      const result = await broadcastChannelText(adapter, post.text);
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
