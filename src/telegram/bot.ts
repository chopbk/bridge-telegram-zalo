import { Bot, type Context } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  addAllowedCustomer,
  allCustomers,
  blockByTopic,
  customerByTopic,
  customerByZaloId,
  editCustomer,
  findCustomers,
  muteByTopic,
  pageCustomers,
  recreateTopicById,
  removeCustomer,
  setStatusByTopic,
  setStatusByZaloId,
} from '../bridge/mapper.js';
import { forwardTopicToZalo } from '../bridge/outbound.js';
import { broadcastChannelText, retryBroadcast } from '../bridge/broadcast.js';
import {
  countByStatus,
  formatCustomerDetail,
  type Customer,
} from '../db/customers.js';
import type { SubscriptionStatus } from '../db/client.js';
import type { ZaloAdapter } from '../zalo/types.js';

const STATUSES = new Set<SubscriptionStatus>([
  'pending',
  'approved',
  'rejected',
  'unsubscribed',
]);

function isAdmin(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (id == null) return false;
  return getEnv().telegramAdminIds.includes(id);
}

function inForumGroup(ctx: Context): boolean {
  return ctx.chat?.id === getEnv().telegramForumGroupId;
}

async function requireAdminInForum(ctx: Context): Promise<boolean> {
  if (!inForumGroup(ctx)) return false;
  if (!isAdmin(ctx)) return false;
  return true;
}

function formatCustomerLine(c: Customer, index: number): string {
  const flags = [
    c.subscriptionStatus,
    c.muted ? 'muted' : null,
    c.blocked ? 'blocked' : null,
  ]
    .filter(Boolean)
    .join(',');
  const name = c.displayName ?? '(no name)';
  return `${index}. ${name}\n   zalo=\`${c.zaloUserId}\` topic=${c.telegramTopicId} [${flags}]`;
}

function parseBool(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
  return null;
}

async function replyChunks(ctx: Context, text: string): Promise<void> {
  const send = async (chunk: string) => {
    try {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(chunk.replace(/`/g, ''));
    }
  };
  if (text.length <= 3900) {
    await send(text);
    return;
  }
  let rest = text;
  while (rest.length > 0) {
    await send(rest.slice(0, 3900));
    rest = rest.slice(3900);
  }
}

export function createTelegramBot(adapter: ZaloAdapter): Bot {
  const env = getEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('help', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    await ctx.reply(
      [
        'Quản lý người dùng Zalo:',
        '/users [page] [all|allowed|pending|ids] — đã ghi nhận trong bridge',
        '/zalo_friends [page] — bạn bè trên nick Zalo (lấy id để add)',
        '/user <zalo_id> — chi tiết 1 khách',
        '/user_add <zalo_id> [tên] — thêm vào danh sách cho phép',
        '/user_edit <zalo_id> name=.. status=.. muted=0|1 blocked=0|1',
        '/user_del <zalo_id> — xoá khỏi danh sách (+ topic)',
        '/search <query>',
        '',
        'Trong topic hoặc kèm zalo_id:',
        '/approve [/reject /block /unblock /mute /unmute] [zalo_id]',
        '',
        'Khác: /status /mode /list /recreate /retry_broadcast <jobId>',
      ].join('\n'),
    );
  });

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

  /** Danh sách người dùng Zalo đã chat — dễ copy zalo id */
  bot.command('users', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);

    let page = 1;
    let mode: 'all' | 'allowed' | 'pending' | 'ids' = 'all';
    for (const p of parts) {
      if (/^\d+$/.test(p)) page = Number(p);
      else if (p === 'all' || p === 'allowed' || p === 'pending' || p === 'ids') mode = p;
      else if (p === 'approved') mode = 'allowed';
    }

    if (mode === 'ids') {
      const all = allCustomers(adapter.mode);
      if (all.length === 0) {
        await ctx.reply(emptyUsersHint(adapter.mode));
        return;
      }
      await replyChunks(
        ctx,
        [
          `Zalo IDs (${all.length}) — đã ghi nhận trong bridge DB:`,
          ...all.map((c) => c.zaloUserId),
        ].join('\n'),
      );
      return;
    }

    const statusFilter: SubscriptionStatus | undefined =
      mode === 'allowed' ? 'approved' : mode === 'pending' ? 'pending' : undefined;

    const result = pageCustomers(adapter.mode, page, statusFilter);
    if (result.total === 0) {
      await ctx.reply(
        mode === 'allowed'
          ? 'Chưa có ai trong danh sách cho phép (approved).\nThêm: /user_add <zalo_id> hoặc /zalo_friends rồi add.'
          : emptyUsersHint(adapter.mode),
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const header =
      `Người dùng Zalo — trang ${result.page}/${totalPages} (${result.total})` +
      (mode !== 'all' ? ` · ${mode}` : '');
    const lines = result.items.map((c, i) =>
      formatCustomerLine(c, (result.page - 1) * result.pageSize + i + 1),
    );
    await replyChunks(ctx, [header, ...lines].join('\n'));
  });

  bot.command('list', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);
    let page = 1;
    let status: SubscriptionStatus | undefined;
    for (const p of parts) {
      if (/^\d+$/.test(p)) page = Number(p);
      else if (STATUSES.has(p as SubscriptionStatus)) status = p as SubscriptionStatus;
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
    await replyChunks(ctx, [header, ...lines].join('\n'));
  });

  /**
   * Danh sách bạn bè trên nick Zalo (API), không phải bridge DB.
   * Dùng để lấy zalo_id rồi /user_add.
   */
  bot.command('zalo_friends', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    if (!adapter.listContacts) {
      await ctx.reply('Lệnh này chỉ có ở ZALO_MODE=personal.');
      return;
    }
    const raw = ctx.match?.toString().trim() ?? '';
    const page = Math.max(1, Number(raw.split(/\s+/).find((p) => /^\d+$/.test(p)) ?? 1) || 1);
    const pageSize = env.LIST_PAGE_SIZE;

    try {
      await ctx.reply('Đang lấy danh sách bạn bè Zalo…');
      const contacts = await adapter.listContacts();
      if (contacts.length === 0) {
        await ctx.reply('Nick Zalo không có bạn bè (hoặc API trả rỗng).');
        return;
      }
      const totalPages = Math.max(1, Math.ceil(contacts.length / pageSize));
      const start = (page - 1) * pageSize;
      const slice = contacts.slice(start, start + pageSize);
      const lines = [
        `Bạn bè Zalo — trang ${page}/${totalPages} (${contacts.length})`,
        'Thêm vào bridge: /user_add <zalo_id> [tên]',
        ...slice.map(
          (c, i) =>
            `${start + i + 1}. ${c.displayName}\n   zalo=\`${c.zaloUserId}\`${c.zaloName ? ` (@${c.zaloName})` : ''}`,
        ),
      ];
      await replyChunks(ctx, lines.join('\n'));
    } catch (err) {
      logger.error({ err }, 'zalo_friends failed');
      await ctx.reply('Lấy bạn bè Zalo thất bại. Kiểm tra session / log.');
    }
  });

  bot.command('user', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const zaloId = ctx.match?.toString().trim().split(/\s+/)[0] ?? '';
    if (!zaloId) {
      const topicId = ctx.message?.message_thread_id;
      if (topicId) {
        const c = customerByTopic(topicId, adapter.mode);
        if (!c) {
          await ctx.reply('Không tìm thấy khách cho topic này.');
          return;
        }
        await ctx.reply(formatCustomerDetail(c));
        return;
      }
      await ctx.reply('Dùng: /user <zalo_id> hoặc /user trong topic khách');
      return;
    }
    const c = customerByZaloId(zaloId, adapter.mode);
    if (!c) {
      await ctx.reply(`Không tìm thấy: ${zaloId}`);
      return;
    }
    await ctx.reply(formatCustomerDetail(c));
  });

  bot.command('user_add', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const [zaloId, ...nameParts] = raw.split(/\s+/).filter(Boolean);
    if (!zaloId) {
      await ctx.reply(
        'Dùng: /user_add <zalo_id> [tên hiển thị]\n→ thêm vào danh sách cho phép (approved)',
      );
      return;
    }
    try {
      const { customer, created } = await addAllowedCustomer(
        ctx.api,
        adapter.mode,
        zaloId,
        nameParts.length ? nameParts.join(' ') : undefined,
      );
      await ctx.reply(
        [
          created ? '✅ Đã thêm khách mới (approved)' : '✅ Đã cập nhật khách → approved',
          formatCustomerDetail(customer),
        ].join('\n'),
      );
    } catch (err) {
      logger.error({ err, zaloId }, 'user_add failed');
      await ctx.reply('Thêm thất bại. Xem log.');
    }
  });

  bot.command('user_edit', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      await ctx.reply(
        [
          'Dùng: /user_edit <zalo_id> name=Tên status=approved muted=0 blocked=0',
          'status: pending|approved|rejected|unsubscribed',
        ].join('\n'),
      );
      return;
    }

    const zaloId = tokens[0]!;
    const patch: {
      displayName?: string | null;
      subscriptionStatus?: SubscriptionStatus;
      muted?: boolean;
      blocked?: boolean;
    } = {};

    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1);
      if (!value) continue;

      if (key === 'name' || key === 'display_name' || key === 'display') {
        patch.displayName = value.replace(/_/g, ' ');
      } else if (key === 'status') {
        if (!STATUSES.has(value as SubscriptionStatus)) {
          await ctx.reply(`status không hợp lệ: ${value}`);
          return;
        }
        patch.subscriptionStatus = value as SubscriptionStatus;
      } else if (key === 'muted') {
        const b = parseBool(value);
        if (b == null) {
          await ctx.reply('muted phải là 0|1');
          return;
        }
        patch.muted = b;
      } else if (key === 'blocked') {
        const b = parseBool(value);
        if (b == null) {
          await ctx.reply('blocked phải là 0|1');
          return;
        }
        patch.blocked = b;
      } else {
        await ctx.reply(`Không hiểu key: ${key}`);
        return;
      }
    }

    if (Object.keys(patch).length === 0) {
      await ctx.reply('Không có trường nào để sửa.');
      return;
    }

    const updated = editCustomer(zaloId, adapter.mode, patch);
    if (!updated) {
      await ctx.reply(`Không tìm thấy: ${zaloId}`);
      return;
    }
    await ctx.reply(['✅ Đã sửa', formatCustomerDetail(updated)].join('\n'));
  });

  bot.command('user_del', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const zaloId = ctx.match?.toString().trim().split(/\s+/)[0] ?? '';
    if (!zaloId) {
      await ctx.reply('Dùng: /user_del <zalo_id>\nXoá khỏi DB và cố gắng xoá topic Telegram.');
      return;
    }
    try {
      const removed = await removeCustomer(ctx.api, adapter.mode, zaloId);
      if (!removed) {
        await ctx.reply(`Không tìm thấy: ${zaloId}`);
        return;
      }
      await ctx.reply(
        `🗑 Đã xoá ${removed.displayName ?? removed.zaloUserId} (zalo=${removed.zaloUserId})`,
      );
    } catch (err) {
      logger.error({ err, zaloId }, 'user_del failed');
      await ctx.reply('Xoá thất bại. Xem log.');
    }
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
    await replyChunks(ctx, found.map((c, i) => formatCustomerLine(c, i + 1)).join('\n'));
  });

  async function statusCommand(
    ctx: Context,
    status: SubscriptionStatus,
    okLabel: string,
  ): Promise<void> {
    if (!(await requireAdminInForum(ctx))) return;
    const arg = ctx.match?.toString().trim().split(/\s+/)[0];
    if (arg) {
      const customer = setStatusByZaloId(arg, adapter.mode, status);
      if (!customer) {
        await ctx.reply(`Không tìm thấy zalo id: ${arg}`);
        return;
      }
      await ctx.reply(`${okLabel} ${customer.displayName ?? customer.zaloUserId}`);
      return;
    }
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply(
        `Dùng trong topic hoặc: /${status === 'approved' ? 'approve' : 'reject'} <zalo_id>`,
      );
      return;
    }
    const customer = setStatusByTopic(topicId, adapter.mode, status);
    if (!customer) {
      await ctx.reply('Không tìm thấy khách cho topic này.');
      return;
    }
    await ctx.reply(`${okLabel} ${customer.displayName ?? customer.zaloUserId}`);
  }

  bot.command('approve', async (ctx) => {
    await statusCommand(ctx, 'approved', 'Đã duyệt');
  });

  bot.command('reject', async (ctx) => {
    await statusCommand(ctx, 'rejected', 'Đã từ chối');
  });

  bot.command('block', async (ctx) => {
    if (!(await requireAdminInForum(ctx))) return;
    const arg = ctx.match?.toString().trim().split(/\s+/)[0];
    if (arg) {
      const updated = editCustomer(arg, adapter.mode, { blocked: true });
      if (!updated) {
        await ctx.reply(`Không tìm thấy: ${arg}`);
        return;
      }
      await ctx.reply(`Đã block ${updated.displayName ?? updated.zaloUserId}`);
      return;
    }
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /block trong topic hoặc /block <zalo_id>');
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
    const arg = ctx.match?.toString().trim().split(/\s+/)[0];
    if (arg) {
      const updated = editCustomer(arg, adapter.mode, { blocked: false });
      if (!updated) {
        await ctx.reply(`Không tìm thấy: ${arg}`);
        return;
      }
      await ctx.reply(`Đã unblock ${updated.displayName ?? updated.zaloUserId}`);
      return;
    }
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /unblock trong topic hoặc /unblock <zalo_id>');
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
    const arg = ctx.match?.toString().trim().split(/\s+/)[0];
    if (arg) {
      const updated = editCustomer(arg, adapter.mode, { muted: true });
      if (!updated) {
        await ctx.reply(`Không tìm thấy: ${arg}`);
        return;
      }
      await ctx.reply(`Đã mute broadcast ${updated.displayName ?? updated.zaloUserId}`);
      return;
    }
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /mute trong topic hoặc /mute <zalo_id>');
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
    const arg = ctx.match?.toString().trim().split(/\s+/)[0];
    if (arg) {
      const updated = editCustomer(arg, adapter.mode, { muted: false });
      if (!updated) {
        await ctx.reply(`Không tìm thấy: ${arg}`);
        return;
      }
      await ctx.reply(`Đã unmute ${updated.displayName ?? updated.zaloUserId}`);
      return;
    }
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Dùng /unmute trong topic hoặc /unmute <zalo_id>');
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
      await ctx.reply(
        `Đã tạo lại topic ${customer.telegramTopicId} cho ${customer.displayName ?? customer.zaloUserId}`,
      );
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

function emptyUsersHint(mode: string): string {
  return [
    'Bridge DB chưa có khách nào.',
    '',
    'Lưu ý: /users ≠ lịch sử chat Zalo cũ.',
    'Chỉ ghi nhận khi:',
    '• Có người nhắn nick Zalo trong lúc bridge đang chạy, hoặc',
    '• Admin /user_add <zalo_id>',
    '',
    mode === 'personal'
      ? 'Xem bạn bè Zalo hiện tại: /zalo_friends'
      : 'Thêm thủ công: /user_add <zalo_id>',
  ].join('\n');
}

export async function startTelegramBot(bot: Bot): Promise<void> {
  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'Telegram bot started (polling)'),
  });
}
