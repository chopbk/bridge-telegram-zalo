import { ThreadType, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import { safeUnlink, writeTempImage } from '../../bridge/media.js';
import { touchThreadActivity, getThreadActivityMap } from '../../db/thread-activity.js';
import { claimProcessedMessage } from '../../db/processed.js';
import { notifyAdmins } from '../../telegram/notify.js';
import { getZaloApi, resetZaloClient } from './session.js';
import type {
  ListRecentChatsOptions,
  NormalizedInbound,
  SendImagesOptions,
  SendTextOptions,
  ZaloAdapter,
  ZaloContact,
  ZaloImageAttachment,
  ZaloSendResult,
  ZaloThreadKind,
} from '../types.js';
import { extractLinkAttachment, formatLinkText } from './link.js';
import { captionFromPhotoContent, extractInboundImages } from './photo.js';

type InboundHandler = (msg: NormalizedInbound) => void | Promise<void>;

export class ZaloPersonalAdapter implements ZaloAdapter {
  readonly mode = 'personal' as const;
  private handler: InboundHandler | null = null;
  private readonly queue: SendQueue;
  private started = false;

  constructor() {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS, env.ZALO_SEND_MAX_PER_MINUTE);
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const api = await getZaloApi();
    api.listener.on('message', (message) => {
      void this.handleMessage(message).catch((err) => {
        logger.error({ err }, 'Personal Zalo inbound failed');
      });
    });
    api.listener.start();
    this.started = true;
    logger.info(
      {
        mode: this.mode,
        minIntervalMs: getEnv().ZALO_MIN_SEND_INTERVAL_MS,
        maxPerMinute: getEnv().ZALO_SEND_MAX_PER_MINUTE,
      },
      'ZaloPersonalAdapter listener started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      const api = await getZaloApi();
      api.listener.stop();
    } catch {
      // ignore
    }
    this.handler = null;
    this.started = false;
  }

  private async handleMessage(message: ZaloListenerMessage): Promise<void> {
    // User + Group (group chỉ forward nếu đã có trong DB — inbound lọc)
    if (message.type !== ThreadType.User && message.type !== ThreadType.Group) return;

    const threadKind: ZaloThreadKind =
      message.type === ThreadType.Group ? 'group' : 'user';
    // GroupMessage.threadId = idTo = group id; UserMessage.threadId = peer user id
    const zaloUserId = String(message.threadId);
    const senderName =
      typeof message.data.dName === 'string' ? message.data.dName : undefined;
    const senderId =
      message.data.uidFrom != null ? String(message.data.uidFrom) : undefined;
    const atMs =
      normalizeZaloTs(
        message.data.ts != null ? Number(message.data.ts) : undefined,
      ) ?? Date.now();
    // Activity theo thread (group id / user id) — không gắn tên người gửi vào group
    touchThreadActivity(
      this.mode,
      zaloUserId,
      threadKind,
      atMs,
      threadKind === 'user' ? senderName : undefined,
    );

    if (!this.handler) return;

    const content = message.data.content;
    const messageId =
      message.data.msgId != null ? String(message.data.msgId) : undefined;
    const msgType =
      typeof message.data.msgType === 'string' ? message.data.msgType : undefined;
    const isSelf = Boolean(message.isSelf);

    const base = {
      zaloUserId,
      threadKind,
      senderId: threadKind === 'group' ? senderId : undefined,
      senderName: threadKind === 'group' ? senderName : undefined,
      // 1-1: tên peer; bỏ qua khi isSelf để không đổi tên topic thành tên mình
      displayName: threadKind === 'user' && !isSelf ? senderName : undefined,
      messageId,
      isSelf,
    };

    if (typeof content === 'string' && content.trim()) {
      await this.handler({ ...base, text: content });
      return;
    }

    const images = extractInboundImages(content, msgType);
    if (images && images.length > 0) {
      await this.handler({
        ...base,
        text: captionFromPhotoContent(content),
        images,
      });
      return;
    }

    const link = extractLinkAttachment(content, msgType);
    if (link) {
      await this.handler({
        ...base,
        text: formatLinkText(link),
        images: link.thumb ? [{ url: link.thumb }] : undefined,
      });
      return;
    }

    // Non-text: still surface to Telegram
    const kind = describeUnsupportedContent(content, msgType);
    await this.handler({
      ...base,
      text: '',
      unsupportedKind: kind,
    });
  }

  async listContacts(): Promise<ZaloContact[]> {
    const api = await getZaloApi();
    const friends = await api.getAllFriends();
    return (friends ?? []).map((f) => mapFriend(f));
  }

  /**
   * Chat gần đây: user theo friends.lastActionTime; group theo
   * unread.ts + activity DB + (tuỳ chọn) probe getGroupChatHistory —
   * không dùng createdTime (sai thứ tự "gần đây").
   */
  async listRecentChats(
    limit = 50,
    opts?: ListRecentChatsOptions,
  ): Promise<ZaloContact[]> {
    const api = await getZaloApi();
    const capped = Math.max(1, Math.min(limit, 200));
    const focus = opts?.focus ?? 'all';
    const probeHistory =
      opts?.probeGroupHistory ?? focus === 'group';

    const activityMap = getThreadActivityMap(this.mode);
    const unreadTs = new Map<string, number>();
    const pinned = new Set<string>();

    try {
      if (typeof api.getUnreadMark === 'function') {
        const unread = await api.getUnreadMark();
        for (const u of unread?.data?.convsUser ?? []) {
          const id = String(u.fromUid ?? u.id ?? '');
          const ts = normalizeZaloTs(u.ts != null ? Number(u.ts) : undefined);
          if (id && ts) unreadTs.set(id, ts);
        }
        for (const g of unread?.data?.convsGroup ?? []) {
          const id = String(g.id ?? g.fromUid ?? '');
          const ts = normalizeZaloTs(g.ts != null ? Number(g.ts) : undefined);
          if (id && ts) unreadTs.set(id, ts);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'getUnreadMark failed');
    }

    try {
      if (typeof api.getPinConversations === 'function') {
        const pin = await api.getPinConversations();
        for (const raw of pin?.conversations ?? []) {
          if (raw.startsWith('u') || raw.startsWith('g')) pinned.add(raw.slice(1));
          else pinned.add(raw);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'getPinConversations failed');
    }

    const pickActive = (id: string, fallback?: number): number | undefined => {
      const candidates = [activityMap.get(id), unreadTs.get(id), fallback].filter(
        (n): n is number => typeof n === 'number' && n > 0,
      );
      return candidates.length ? Math.max(...candidates) : undefined;
    };

    const items: ZaloContact[] = [];

    if (focus !== 'group') {
      const friends = await api.getAllFriends();
      for (const f of friends ?? []) {
        const id = String(f.userId);
        const last =
          pickActive(id, normalizeZaloTs(f.lastActionTime)) ??
          normalizeZaloTs(f.lastActionTime);
        if (!last && !pinned.has(id)) continue;
        items.push({
          ...mapFriend(f),
          kind: 'user',
          lastActiveAt: last,
        });
      }
    }

    if (focus !== 'user') {
      try {
        const groupsResult = await api.getAllGroups();
        const groupIds = Object.keys(groupsResult?.gridVerMap ?? {});
        const groups: ZaloContact[] = [];
        const batchSize = 40;
        for (let i = 0; i < groupIds.length; i += batchSize) {
          const batch = groupIds.slice(i, i + batchSize);
          try {
            const info = await api.getGroupInfo(batch);
            const map = info?.gridInfoMap ?? {};
            for (const [gid, g] of Object.entries(map)) {
              const id = String(gid);
              groups.push({
                zaloUserId: id,
                displayName: g.name || `Group ${id}`,
                kind: 'group',
                memberCount: g.totalMember,
                lastActiveAt: pickActive(id),
              });
            }
          } catch (err) {
            logger.warn({ err, batchSize: batch.length }, 'getGroupInfo batch failed');
          }
        }

        const missing = groups.filter((g) => g.lastActiveAt == null);
        if (probeHistory && missing.length > 0 && typeof api.getGroupChatHistory === 'function') {
          // Ưu tiên probe group ghim / chưa có ts — tối đa 120 để tránh quá lâu
          const toProbe = missing.slice(0, 120);
          logger.info(
            { count: toProbe.length, totalGroups: groups.length },
            'Probing group chat history for last activity',
          );
          const probed = await mapPool(toProbe, 6, async (g) => {
            const ts = await probeGroupLastMessageTs(api, g.zaloUserId);
            return { id: g.zaloUserId, ts, name: g.displayName };
          });
          for (const p of probed) {
            if (!p.ts) continue;
            touchThreadActivity(this.mode, p.id, 'group', p.ts, p.name);
            const g = groups.find((x) => x.zaloUserId === p.id);
            if (g) g.lastActiveAt = p.ts;
          }
        }

        items.push(...groups);
      } catch (err) {
        logger.warn({ err }, 'getAllGroups failed — returning without groups');
      }
    }

    // Ghim trước, rồi theo lastActiveAt giảm dần (không dùng createdTime)
    items.sort((a, b) => {
      const ap = pinned.has(a.zaloUserId) ? 1 : 0;
      const bp = pinned.has(b.zaloUserId) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
    });

    return items.slice(0, capped);
  }

  async resolveThreadKind(zaloId: string): Promise<ZaloThreadKind> {
    const meta = await this.resolveThreadMeta(zaloId);
    return meta.kind;
  }

  async resolveThreadMeta(
    zaloId: string,
  ): Promise<{ kind: ZaloThreadKind; displayName?: string }> {
    const api = await getZaloApi();
    const id = String(zaloId);

    try {
      const info = await api.getGroupInfo(id);
      const map = info?.gridInfoMap ?? {};
      const g = map[id] ?? Object.entries(map).find(([k]) => String(k) === id)?.[1];
      if (g) {
        const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : undefined;
        return { kind: 'group', displayName: name };
      }
    } catch (err) {
      logger.warn({ err, zaloId: id }, 'resolveThreadMeta getGroupInfo failed — try user');
    }

    try {
      if (typeof api.getUserInfo === 'function') {
        const users = await api.getUserInfo(id);
        const profile =
          users?.changed_profiles?.[id] ??
          users?.unchanged_profiles?.[id] ??
          Object.values(users?.changed_profiles ?? {})[0] ??
          Object.values(users?.unchanged_profiles ?? {})[0];
        if (profile) {
          const name =
            (typeof profile.displayName === 'string' && profile.displayName.trim()
              ? profile.displayName.trim()
              : undefined) ||
            (typeof profile.zaloName === 'string' && profile.zaloName.trim()
              ? profile.zaloName.trim()
              : undefined);
          return { kind: 'user', displayName: name };
        }
      }
    } catch (err) {
      logger.warn({ err, zaloId: id }, 'resolveThreadMeta getUserInfo failed');
    }

    return { kind: 'user' };
  }

  sendText(userId: string, text: string, opts?: SendTextOptions): Promise<ZaloSendResult> {
    const threadKind = opts?.threadKind ?? 'user';
    const threadType = threadKind === 'group' ? ThreadType.Group : ThreadType.User;
    return this.queue.enqueue(async () => {
      try {
        const api = await getZaloApi();
        const result = await api.sendMessage(text, userId, threadType);
        const messageId = result.message?.msgId;
        touchThreadActivity(this.mode, userId, threadKind, Date.now());
        // Claim để echo isSelf từ listener không forward lại topic
        if (messageId != null && String(messageId) !== 'ok') {
          claimProcessedMessage(this.mode, String(messageId));
        }
        logger.info(
          { userId, threadKind, messageId },
          'Personal Zalo sendText ok',
        );
        return {
          messageId: messageId !== undefined && messageId !== null ? String(messageId) : 'ok',
        };
      } catch (err) {
        resetZaloClient();
        logger.error({ err, userId, threadKind }, 'Personal Zalo send failed');
        const message = err instanceof Error ? err.message : String(err);
        void notifyAdmins(
          `Zalo personal send failed for ${userId} (${threadKind}): ${message}`,
        );
        throw err;
      }
    });
  }

  sendImages(
    userId: string,
    images: ZaloImageAttachment[],
    opts?: SendImagesOptions,
  ): Promise<ZaloSendResult> {
    if (!images.length) {
      return Promise.reject(new Error('sendImages: empty images'));
    }
    const threadKind = opts?.threadKind ?? 'user';
    const threadType = threadKind === 'group' ? ThreadType.Group : ThreadType.User;
    const caption = (opts?.caption ?? '').trim();
    return this.queue.enqueue(async () => {
      // Gửi bằng đường dẫn file tạm — ổn định hơn Buffer với zca-js (cần imageMetadataGetter)
      const tempPaths: string[] = [];
      try {
        for (const img of images) {
          const ext = img.filename.split('.').pop() || 'jpg';
          tempPaths.push(await writeTempImage(img.data, ext));
        }
        const api = await getZaloApi();
        const result = await api.sendMessage(
          {
            msg: caption,
            attachments: tempPaths.length === 1 ? tempPaths[0]! : tempPaths,
          },
          userId,
          threadType,
        );
        const attachments = (result.attachment ?? []).filter(Boolean);
        const messageId =
          result.message?.msgId ?? attachments[0]?.msgId ?? null;
        if (!messageId && attachments.length === 0) {
          throw new Error(
            'Zalo trả về attachment rỗng — kiểm tra listener đang chạy và định dạng ảnh (jpg/png/webp)',
          );
        }
        touchThreadActivity(this.mode, userId, threadKind, Date.now());
        for (const a of attachments) {
          const id = a?.msgId;
          if (id != null && String(id) !== 'ok') {
            claimProcessedMessage(this.mode, String(id));
          }
        }
        if (messageId != null && String(messageId) !== 'ok') {
          claimProcessedMessage(this.mode, String(messageId));
        }
        logger.info(
          { userId, threadKind, count: images.length, messageId, attachmentCount: attachments.length },
          'Personal Zalo sendImages ok',
        );
        return {
          messageId: messageId !== undefined && messageId !== null ? String(messageId) : 'ok',
        };
      } catch (err) {
        resetZaloClient();
        logger.error({ err, userId, threadKind, count: images.length }, 'Personal Zalo sendImages failed');
        const message = err instanceof Error ? err.message : String(err);
        void notifyAdmins(
          `Zalo personal sendImages failed for ${userId} (${threadKind}): ${message}`,
        );
        throw err;
      } finally {
        await Promise.all(tempPaths.map((p) => safeUnlink(p)));
      }
    });
  }
}

function describeUnsupportedContent(content: unknown, msgType?: string): string {
  if (msgType && msgType !== 'webchat') return msgType.replace(/^chat\./, '') || msgType;
  if (content == null) return 'empty';
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (obj.title || obj.href || obj.thumb) return 'link/attachment';
    if ('action' in obj) return 'action';
    return 'media/object';
  }
  return typeof content;
}

function normalizeZaloTs(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  // seconds vs ms heuristic
  return raw < 1e12 ? raw * 1000 : raw;
}

async function probeGroupLastMessageTs(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  groupId: string,
): Promise<number | undefined> {
  try {
    const hist = await api.getGroupChatHistory!(groupId, 1);
    const msgs = hist?.groupMsgs ?? [];
    let best: number | undefined;
    for (const m of msgs) {
      const raw =
        m && typeof m === 'object'
          ? ((m as { data?: { ts?: string | number }; ts?: string | number }).data?.ts ??
            (m as { ts?: string | number }).ts)
          : undefined;
      const ts = normalizeZaloTs(raw != null ? Number(raw) : undefined);
      if (ts != null && (best == null || ts > best)) best = ts;
    }
    return best;
  } catch (err) {
    logger.warn({ err, groupId }, 'getGroupChatHistory probe failed');
    return undefined;
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function mapFriend(f: {
  userId: string;
  username?: string;
  displayName?: string;
  zaloName?: string;
  lastActionTime?: number;
}): ZaloContact {
  return {
    zaloUserId: String(f.userId),
    displayName: f.displayName || f.zaloName || f.username || String(f.userId),
    zaloName: f.zaloName || undefined,
    lastActiveAt: normalizeZaloTs(f.lastActionTime),
    kind: 'user',
  };
}
