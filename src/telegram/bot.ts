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
import { forwardTopicImagesToZalo, forwardTopicToZalo } from '../bridge/outbound.js';
import { bufferToZaloImage, downloadToBuffer, telegramFileUrl } from '../bridge/media.js';
import {
  broadcastChannelPhotos,
  broadcastChannelText,
  retryBroadcast,
} from '../bridge/broadcast.js';
import {
  countByStatus,
  formatCustomerDetail,
  type Customer,
} from '../db/customers.js';
import type { SubscriptionStatus } from '../db/client.js';
import type { ZaloAdapter, ZaloImageAttachment } from '../zalo/types.js';
import { buildConfigReport } from './config-report.js';
import { notifyAdmins } from './notify.js';

/** Gom album Telegram (media_group_id) trước khi gửi Zalo */
type PendingAlbum = {
  topicId: number;
  caption?: string;
  captionEntities?: Array<{ type: string; offset: number; length: number; url?: string }>;
  fileIds: string[];
  timer?: ReturnType<typeof setTimeout>;
};
const pendingAlbums = new Map<string, PendingAlbum>();

/** Album ảnh trên channel → broadcast */
type PendingChannelAlbum = {
  channelId: number;
  caption?: string;
  fileIds: string[];
  messageId?: number;
  timer?: ReturnType<typeof setTimeout>;
};
const pendingChannelAlbums = new Map<string, PendingChannelAlbum>();
const ALBUM_FLUSH_MS = 900;

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

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

/** Admin được dùng lệnh trong forum group hoặc chat riêng với bot. */
async function requireAdmin(ctx: Context): Promise<boolean> {
  if (!isAdmin(ctx)) return false;
  if (isPrivateChat(ctx) || inForumGroup(ctx)) return true;
  return false;
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
  return `${index}. [${c.threadKind}] ${name}\n   zalo=${c.zaloUserId} topic=${c.telegramTopicId} [${flags}]`;
}

function parseBool(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
  return null;
}

/** Tách nhiều zalo id: `111,222, 333` */
function parseCommaIds(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Lấy danh sách id ở đầu lệnh (có thể `id1,id2` hoặc `id1, id2`),
 * rồi phần còn lại (group|user / name=… / patch).
 */
function takeLeadingIds(parts: string[]): { ids: string[]; rest: string[] } {
  if (parts.length === 0) return { ids: [], rest: [] };
  const idTokens: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === 'group' || p === 'user') break;
    if (p.includes('=')) break;
    // id hoặc chuỗi id phân tách phẩy
    if (/^[\d,\s]+$/.test(p) || (p.includes(',') && !p.includes('='))) {
      idTokens.push(p);
      continue;
    }
    if (/^\d+$/.test(p)) {
      idTokens.push(p);
      continue;
    }
    break;
  }
  const ids = parseCommaIds(idTokens.join(','));
  return { ids, rest: parts.slice(i) };
}

/** Plain text — tách tin theo ~3900 ký tự, ưu tiên cắt ở xuống dòng. */
async function replyChunks(ctx: Context, text: string): Promise<void> {
  const MAX = 3900;
  if (text.length <= MAX) {
    await ctx.reply(text);
    return;
  }
  const lines = text.split('\n');
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length <= MAX) {
      buf = next;
      continue;
    }
    if (buf) {
      await ctx.reply(buf);
      buf = '';
    }
    if (line.length <= MAX) {
      buf = line;
      continue;
    }
    let rest = line;
    while (rest.length > 0) {
      await ctx.reply(rest.slice(0, MAX));
      rest = rest.slice(MAX);
    }
  }
  if (buf) await ctx.reply(buf);
}

export function createTelegramBot(adapter: ZaloAdapter): Bot {
  const env = getEnv();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('help', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await replyChunks(
      ctx,
      [
        '── Hướng dẫn admin ──',
        'Dùng trong forum hoặc chat riêng với bot.',
        'Reply text/ảnh trong topic → gửi Zalo (khách phải approved).',
        '',
        '▸ Xem danh sách',
        '/users              khách đã có trong bridge',
        '/users allowed      chỉ approved',
        '/users pending      chờ duyệt',
        '/zalochats          chat gần đây (Zalo)',
        '/zalochats group    chỉ group',
        '/zalofriends        bạn bè nick Zalo',
        '/search <từ khóa>   tìm theo tên / id',
        '/user <zalo_id>     chi tiết 1 khách',
        '',
        '▸ Thêm / sửa / xoá (nhiều id: cách nhau bởi ,)',
        '/useradd <id>[,id…] [group|user] [tên]',
        '/useredit <id>[,id…] name=… status=…',
        '/userdel <id>[,id…]',
        '',
        '▸ Duyệt trong topic (hoặc kèm id)',
        '/approve   /reject',
        '/block     /unblock',
        '/mute      /unmute     (tắt/bật nhận broadcast)',
        '',
        '▸ Hệ thống',
        '/status              thống kê nhanh',
        '/config              cấu hình + kiểm tra quyền',
        '/recreate            tạo lại topic bị xoá',
        '/retrybroadcast <id> gửi lại broadcast lỗi',
        '/mode                personal | bot',
        '',
        'HD đầy đủ: docs/ADMIN.vi.md trên GitHub',
      ].join('\n'),
    );
  });

  bot.command('mode', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.reply(`ZALO_MODE=${adapter.mode}`);
  });

  bot.command('status', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
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
        `channels: ${env.telegramChannelIds.join(',')}`,
        `admins: ${env.telegramAdminIds.length}`,
        'Chi tiết cấu hình: /config',
      ].join('\n'),
    );
  });

  bot.command(['config', 'settings', 'check'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    try {
      const report = await buildConfigReport(ctx.api, adapter);
      await replyChunks(ctx, report);
    } catch (err) {
      logger.error({ err }, 'config report failed');
      const detail = err instanceof Error ? err.message : 'Không lấy được cấu hình.';
      await ctx.reply(detail);
    }
  });

  /** Danh sách người dùng Zalo đã chat — dễ copy zalo id */
  bot.command('users', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
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
          ? 'Chưa có ai trong danh sách cho phép (approved).\nThêm: /useradd <zalo_id> hoặc /zalofriends rồi add.'
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
    if (!(await requireAdmin(ctx))) return;
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
   * Dùng để lấy zalo_id rồi /useradd.
   */
  bot.command(['zalofriends', 'zalo_friends'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
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
        'Thêm vào bridge: /useradd <zalo_id> [tên]',
        ...slice.map(
          (c, i) =>
            `${start + i + 1}. ${c.displayName}\n   zalo=${c.zaloUserId}${c.zaloName ? ` (@${c.zaloName})` : ''}`,
        ),
      ];
      await replyChunks(ctx, lines.join('\n'));
    } catch (err) {
      logger.error({ err }, 'zalofriends failed');
      await ctx.reply('Lấy bạn bè Zalo thất bại. Kiểm tra session / log.');
    }
  });

  /**
   * Chat gần đây với nick Zalo (1-1 + group) — gửi full, tách tin tránh limit.
   */
  bot.command(['zalochats', 'zalo_chats'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    if (!adapter.listRecentChats) {
      await ctx.reply('Lệnh này chỉ có ở ZALO_MODE=personal.');
      return;
    }

    const raw = ctx.match?.toString().trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);
    let limit = 200;
    let filter: 'all' | 'user' | 'group' = 'all';
    for (const p of parts) {
      if (p === 'user' || p === 'users' || p === 'friend' || p === 'friends') filter = 'user';
      else if (p === 'group' || p === 'groups') filter = 'group';
      else if (p.startsWith('n=') || p.startsWith('limit=')) {
        const n = Number(p.split('=')[1]);
        if (Number.isFinite(n)) limit = Math.min(200, Math.max(1, n));
      } else if (/^\d+$/.test(p)) {
        limit = Math.min(200, Math.max(1, Number(p)));
      }
    }

    try {
      const focusLabel =
        filter === 'group' ? 'group (đang probe tin cuối…)' : filter === 'user' ? 'user' : 'user + group';
      await ctx.reply(`Đang lấy chat gần đây — ${focusLabel} (full list)`);
      const chats = await adapter.listRecentChats(limit, {
        focus: filter,
        probeGroupHistory: filter === 'group',
      });

      if (chats.length === 0) {
        await ctx.reply(
          'Không có chat gần đây.\nThử /zalofriends hoặc /zalochats group.',
        );
        return;
      }

      const userCount = chats.filter((c) => c.kind !== 'group').length;
      const groupCount = chats.filter((c) => c.kind === 'group').length;
      const lines = [
        `Chat gần đây — ${chats.length} mục (${userCount} user, ${groupCount} group)`,
        'Sắp xếp: ghim → hoạt động gần nhất',
        'Thêm: /useradd <id> [group|user] [tên] · lọc: /zalochats user | group',
        ...chats.map((c, i) => {
          const kind = c.kind === 'group' ? 'group' : 'user';
          const extra =
            kind === 'group' && c.memberCount != null ? ` · ${c.memberCount} mem` : '';
          const when = c.lastActiveAt
            ? new Date(c.lastActiveAt).toLocaleString('vi-VN', { hour12: false })
            : 'chưa rõ';
          return `${i + 1}. [${kind}] ${c.displayName}\n   id=${c.zaloUserId}${extra} · ${when}`;
        }),
      ];
      await replyChunks(ctx, lines.join('\n'));
    } catch (err) {
      logger.error({ err }, 'zalochats failed');
      await ctx.reply('Lấy chat gần đây thất bại. Kiểm tra session / log.');
    }
  });

  bot.command('user', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
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

  bot.command(['useradd', 'user_add'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const parts = raw.split(/\s+/).filter(Boolean);
    const { ids, rest } = takeLeadingIds(parts);
    if (ids.length === 0) {
      await ctx.reply(
        [
          'Dùng:',
          '/useradd <zalo_id> [group|user] [tên]',
          '/useradd <id1>,<id2>,<id3> [group|user]',
          '→ thêm allowlist (approved). Nhiều id cách nhau bởi dấu phẩy.',
          'Không ghi tên thì bot tự lấy từ Zalo (từng id).',
        ].join('\n'),
      );
      return;
    }

    let forceKind: 'user' | 'group' | undefined;
    let nameParts = rest;
    if (nameParts[0] === 'group' || nameParts[0] === 'user') {
      forceKind = nameParts[0] as 'user' | 'group';
      nameParts = nameParts.slice(1);
    }
    // Tên chung chỉ áp dụng khi thêm 1 id (tránh gán cùng tên cho cả batch)
    const sharedName =
      ids.length === 1 && nameParts.length ? nameParts.join(' ') : undefined;

    if (ids.length > 1) {
      await ctx.reply(`Đang thêm ${ids.length} id…`);
    }

    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const zaloId of ids) {
      try {
        let threadKind = forceKind;
        let displayName = sharedName;
        if (adapter.resolveThreadMeta) {
          const meta = await adapter.resolveThreadMeta(zaloId);
          threadKind = threadKind ?? meta.kind;
          if (!displayName && meta.displayName) displayName = meta.displayName;
        } else if (!threadKind && adapter.resolveThreadKind) {
          threadKind = await adapter.resolveThreadKind(zaloId);
        }
        threadKind = threadKind ?? 'user';

        const { customer, created } = await addAllowedCustomer(
          ctx.api,
          adapter.mode,
          zaloId,
          displayName,
          threadKind,
        );
        ok += 1;
        lines.push(
          `${created ? '+' : '~'} [${customer.threadKind}] ${customer.displayName ?? '—'} id=${customer.zaloUserId}`,
        );
      } catch (err) {
        fail += 1;
        logger.error({ err, zaloId }, 'useradd failed');
        lines.push(`✗ ${zaloId} — ${err instanceof Error ? err.message : 'lỗi'}`);
      }
    }

    await replyChunks(
      ctx,
      [`✅ useradd xong: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command(['useredit', 'user_edit'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    const { ids, rest } = takeLeadingIds(tokens);
    if (ids.length === 0 || rest.length === 0) {
      await ctx.reply(
        [
          'Dùng:',
          '/useredit <zalo_id> name=Tên status=approved kind=group muted=0 blocked=0',
          '/useredit <id1>,<id2> status=approved muted=1',
          'status: pending|approved|rejected|unsubscribed',
          'kind: user|group',
        ].join('\n'),
      );
      return;
    }

    const patch: {
      displayName?: string | null;
      subscriptionStatus?: SubscriptionStatus;
      muted?: boolean;
      blocked?: boolean;
      threadKind?: 'user' | 'group';
    } = {};

    for (const token of rest) {
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
      } else if (key === 'kind' || key === 'thread' || key === 'threadkind') {
        if (value !== 'user' && value !== 'group') {
          await ctx.reply('kind phải là user|group');
          return;
        }
        patch.threadKind = value;
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

    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const zaloId of ids) {
      const updated = editCustomer(zaloId, adapter.mode, patch);
      if (!updated) {
        fail += 1;
        lines.push(`✗ không tìm thấy: ${zaloId}`);
        continue;
      }
      ok += 1;
      lines.push(
        `~ ${updated.displayName ?? '—'} id=${updated.zaloUserId} [${updated.subscriptionStatus}]`,
      );
    }

    await replyChunks(
      ctx,
      [`✅ useredit xong: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command(['userdel', 'user_del'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const { ids } = takeLeadingIds(raw.split(/\s+/).filter(Boolean));
    if (ids.length === 0) {
      await ctx.reply(
        [
          'Dùng:',
          '/userdel <zalo_id>',
          '/userdel <id1>,<id2>,<id3>',
          'Xoá khỏi DB và cố gắng xoá topic Telegram.',
        ].join('\n'),
      );
      return;
    }

    if (ids.length > 1) {
      await ctx.reply(`Đang xoá ${ids.length} id…`);
    }

    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const zaloId of ids) {
      try {
        const removed = await removeCustomer(ctx.api, adapter.mode, zaloId);
        if (!removed) {
          fail += 1;
          lines.push(`✗ không tìm thấy: ${zaloId}`);
          continue;
        }
        ok += 1;
        lines.push(
          `🗑 ${removed.displayName ?? removed.zaloUserId} id=${removed.zaloUserId}`,
        );
      } catch (err) {
        fail += 1;
        logger.error({ err, zaloId }, 'userdel failed');
        lines.push(`✗ ${zaloId} — ${err instanceof Error ? err.message : 'lỗi'}`);
      }
    }

    await replyChunks(
      ctx,
      [`✅ userdel xong: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command('search', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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
    if (!(await requireAdmin(ctx))) return;
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

  bot.command(['retrybroadcast', 'retry_broadcast'], async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const idRaw = ctx.match?.toString().trim() ?? '';
    const jobId = Number(idRaw);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      await ctx.reply('Dùng: /retrybroadcast <jobId>');
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
      logger.error({ err, jobId }, 'retrybroadcast failed');
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
      await forwardTopicToZalo(adapter, topicId, msg.text, msg.entities);
    } catch (err) {
      logger.error({ err, topicId }, 'Topic→Zalo failed');
      const detail = err instanceof Error ? err.message : 'Gửi Zalo thất bại.';
      await ctx.reply(detail).catch(() => undefined);
    }
  });

  bot.on('message:photo', async (ctx) => {
    const msg = ctx.message;
    if (!msg?.photo?.length) return;
    if (msg.chat.id !== env.telegramForumGroupId) return;
    if (ctx.from?.is_bot) return;
    if (ctx.from?.id === ctx.me.id) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return;

    if (!isAdmin(ctx)) {
      logger.info({ from: ctx.from?.id, topicId }, 'Non-admin photo in topic ignored');
      return;
    }

    const largest = msg.photo[msg.photo.length - 1]!;
    const caption = typeof msg.caption === 'string' ? msg.caption : undefined;
    const captionEntities = msg.caption_entities;
    const groupId = msg.media_group_id;

    if (!groupId) {
      try {
        logger.info({ topicId, fileId: largest.file_id }, 'Forwarding topic photo → Zalo');
        const images = await downloadTelegramPhotos(ctx.api, env.TELEGRAM_BOT_TOKEN, [
          largest.file_id,
        ]);
        await forwardTopicImagesToZalo(
          adapter,
          topicId,
          images,
          caption,
          captionEntities,
        );
      } catch (err) {
        logger.error({ err, topicId }, 'Topic photo→Zalo failed');
        const detail = err instanceof Error ? err.message : 'Gửi ảnh Zalo thất bại.';
        await ctx.reply(detail).catch(() => undefined);
      }
      return;
    }

    // Album: gom theo media_group_id rồi flush
    const key = `${topicId}:${groupId}`;
    let pending = pendingAlbums.get(key);
    if (!pending) {
      pending = { topicId, caption, captionEntities, fileIds: [] };
      pendingAlbums.set(key, pending);
    }
    if (caption && !pending.caption) {
      pending.caption = caption;
      pending.captionEntities = captionEntities;
    }
    pending.fileIds.push(largest.file_id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      void flushAlbum(key, adapter, ctx, env.TELEGRAM_BOT_TOKEN);
    }, ALBUM_FLUSH_MS);
  });

  bot.on('channel_post:text', async (ctx) => {
    const post = ctx.channelPost;
    if (!post || !('text' in post) || !post.text) return;
    if (!env.telegramChannelIds.includes(post.chat.id)) return;

    try {
      const result = await broadcastChannelText(adapter, post.text, {
        channelMessageId: post.message_id,
      });
      logger.info({ result, channelId: post.chat.id }, 'Channel broadcast done');
    } catch (err) {
      logger.error({ err, channelId: post.chat.id }, 'Channel broadcast failed');
    }
  });

  bot.on('channel_post:photo', async (ctx) => {
    const post = ctx.channelPost;
    if (!post || !('photo' in post) || !post.photo?.length) return;
    if (!env.telegramChannelIds.includes(post.chat.id)) return;

    const largest = post.photo[post.photo.length - 1]!;
    const caption = typeof post.caption === 'string' ? post.caption : undefined;
    const groupId = post.media_group_id;

    if (!groupId) {
      try {
        logger.info(
          { channelId: post.chat.id, fileId: largest.file_id },
          'Broadcasting channel photo → Zalo',
        );
        const result = await broadcastChannelPhotos(adapter, [largest.file_id], {
          caption,
          channelMessageId: post.message_id,
        });
        logger.info({ result, channelId: post.chat.id }, 'Channel photo broadcast done');
      } catch (err) {
        logger.error({ err, channelId: post.chat.id }, 'Channel photo broadcast failed');
        await notifyAdmins(
          `Broadcast ảnh channel thất bại: ${err instanceof Error ? err.message : String(err)}`,
        ).catch(() => undefined);
      }
      return;
    }

    const key = `${post.chat.id}:${groupId}`;
    let pending = pendingChannelAlbums.get(key);
    if (!pending) {
      pending = {
        channelId: post.chat.id,
        caption,
        fileIds: [],
        messageId: post.message_id,
      };
      pendingChannelAlbums.set(key, pending);
    }
    if (caption && !pending.caption) pending.caption = caption;
    pending.fileIds.push(largest.file_id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      void flushChannelAlbum(key, adapter);
    }, ALBUM_FLUSH_MS);
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
    '• Admin /useradd <zalo_id>',
    '',
    mode === 'personal'
      ? 'Xem bạn bè Zalo hiện tại: /zalofriends'
      : 'Thêm thủ công: /useradd <zalo_id>',
  ].join('\n');
}

async function downloadTelegramPhotos(
  api: Context['api'],
  botToken: string,
  fileIds: string[],
): Promise<ZaloImageAttachment[]> {
  const out: ZaloImageAttachment[] = [];
  for (let i = 0; i < fileIds.length; i++) {
    const file = await api.getFile(fileIds[i]!);
    if (!file.file_path) {
      throw new Error(`Telegram getFile thiếu file_path (id=${fileIds[i]})`);
    }
    const url = await telegramFileUrl(botToken, file.file_path);
    const buf = await downloadToBuffer(url);
    const ext = file.file_path.includes('.')
      ? file.file_path.split('.').pop() || 'jpg'
      : 'jpg';
    out.push(bufferToZaloImage(buf, `tg-photo-${i + 1}.${ext}`));
  }
  return out;
}

async function flushAlbum(
  key: string,
  adapter: ZaloAdapter,
  ctx: Context,
  botToken: string,
): Promise<void> {
  const pending = pendingAlbums.get(key);
  if (!pending) return;
  pendingAlbums.delete(key);

  try {
    const images = await downloadTelegramPhotos(ctx.api, botToken, pending.fileIds);
    await forwardTopicImagesToZalo(
      adapter,
      pending.topicId,
      images,
      pending.caption,
      pending.captionEntities,
    );
  } catch (err) {
    logger.error({ err, topicId: pending.topicId, key }, 'Album photo→Zalo failed');
    const detail = err instanceof Error ? err.message : 'Gửi album ảnh Zalo thất bại.';
    await ctx.reply(detail).catch(() => undefined);
  }
}

async function flushChannelAlbum(key: string, adapter: ZaloAdapter): Promise<void> {
  const pending = pendingChannelAlbums.get(key);
  if (!pending) return;
  pendingChannelAlbums.delete(key);

  try {
    const result = await broadcastChannelPhotos(adapter, pending.fileIds, {
      caption: pending.caption,
      channelMessageId: pending.messageId,
    });
    logger.info(
      { result, channelId: pending.channelId, count: pending.fileIds.length },
      'Channel album broadcast done',
    );
  } catch (err) {
    logger.error({ err, channelId: pending.channelId, key }, 'Channel album broadcast failed');
    await notifyAdmins(
      `Broadcast album channel thất bại: ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => undefined);
  }
}

export async function startTelegramBot(bot: Bot): Promise<void> {
  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'Telegram bot started (polling)'),
  });
}
