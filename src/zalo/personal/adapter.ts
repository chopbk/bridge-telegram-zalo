import { ThreadType, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';
import { SendQueue } from '../../bridge/queue.js';
import { notifyAdmins } from '../../telegram/notify.js';
import { getZaloApi, resetZaloClient } from './session.js';
import type {
  NormalizedInbound,
  SendTextOptions,
  ZaloAdapter,
  ZaloContact,
  ZaloSendResult,
  ZaloThreadKind,
} from '../types.js';

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
    if (message.isSelf) return;
    if (message.type !== ThreadType.User) return;
    if (!this.handler) return;

    const content = message.data.content;
    const displayName =
      typeof message.data.dName === 'string' ? message.data.dName : undefined;
    const messageId =
      message.data.msgId != null ? String(message.data.msgId) : undefined;
    const zaloUserId = String(message.threadId);

    if (typeof content === 'string' && content.trim()) {
      await this.handler({
        zaloUserId,
        text: content,
        displayName,
        messageId,
      });
      return;
    }

    // Non-text: still surface to Telegram
    const kind = describeUnsupportedContent(content);
    await this.handler({
      zaloUserId,
      text: '',
      displayName,
      messageId,
      unsupportedKind: kind,
    });
  }

  async listContacts(): Promise<ZaloContact[]> {
    const api = await getZaloApi();
    const friends = await api.getAllFriends();
    return (friends ?? []).map((f) => mapFriend(f));
  }

  /**
   * Recent chats: 1-1 (friends.lastActionTime) + groups (getAllGroups).
   * Zalo has no dedicated "recent chats" API — same approach as zca CLIs.
   */
  async listRecentChats(limit = 50): Promise<ZaloContact[]> {
    const api = await getZaloApi();
    const capped = Math.max(1, Math.min(limit, 200));
    const items: ZaloContact[] = [];

    const friends = await api.getAllFriends();
    const users = [...(friends ?? [])]
      .filter((f) => (f.lastActionTime ?? 0) > 0)
      .sort((a, b) => (b.lastActionTime ?? 0) - (a.lastActionTime ?? 0))
      .slice(0, capped)
      .map((f) => ({ ...mapFriend(f), kind: 'user' as const }));
    items.push(...users);

    try {
      const groupsResult = await api.getAllGroups();
      const groupIds = Object.keys(groupsResult?.gridVerMap ?? {});
      const take = groupIds.slice(0, capped);
      const batchSize = 40;
      for (let i = 0; i < take.length; i += batchSize) {
        const batch = take.slice(i, i + batchSize);
        try {
          const info = await api.getGroupInfo(batch);
          const map = info?.gridInfoMap ?? {};
          for (const [gid, g] of Object.entries(map)) {
            items.push({
              zaloUserId: String(gid),
              displayName: g.name || `Group ${gid}`,
              kind: 'group',
              memberCount: g.totalMember,
              lastActiveAt: normalizeZaloTs(g.createdTime),
            });
          }
        } catch (err) {
          logger.warn({ err, batchSize: batch.length }, 'getGroupInfo batch failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'getAllGroups failed — returning users only');
    }

    const unreadUser = new Set<string>();
    const unreadGroup = new Set<string>();
    const pinned = new Set<string>();

    try {
      if (typeof api.getUnreadMark === 'function') {
        const unread = await api.getUnreadMark();
        for (const u of unread?.data?.convsUser ?? []) {
          const id = String(u.fromUid ?? u.id ?? '');
          if (id) unreadUser.add(id);
        }
        for (const g of unread?.data?.convsGroup ?? []) {
          const id = String(g.id ?? g.fromUid ?? '');
          if (id) unreadGroup.add(id);
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

    const score = (c: ZaloContact): number => {
      let s = c.lastActiveAt ?? 0;
      const isUnread =
        c.kind === 'group' ? unreadGroup.has(c.zaloUserId) : unreadUser.has(c.zaloUserId);
      if (isUnread) s += 1e15;
      if (pinned.has(c.zaloUserId)) s += 1e14;
      // Prefer users slightly when scores equal-ish (users have real lastActionTime)
      if (c.kind === 'user') s += 1e10;
      return s;
    };

    items.sort((a, b) => score(b) - score(a));
    return items.slice(0, Math.min(items.length, capped * 2));
  }

  async resolveThreadKind(zaloId: string): Promise<ZaloThreadKind> {
    try {
      const api = await getZaloApi();
      const info = await api.getGroupInfo(zaloId);
      if (info?.gridInfoMap && info.gridInfoMap[zaloId]) {
        return 'group';
      }
    } catch (err) {
      logger.warn({ err, zaloId }, 'resolveThreadKind getGroupInfo failed — assume user');
    }
    return 'user';
  }

  sendText(userId: string, text: string, opts?: SendTextOptions): Promise<ZaloSendResult> {
    const threadKind = opts?.threadKind ?? 'user';
    const threadType = threadKind === 'group' ? ThreadType.Group : ThreadType.User;
    return this.queue.enqueue(async () => {
      try {
        const api = await getZaloApi();
        const result = await api.sendMessage(text, userId, threadType);
        const messageId = result.message?.msgId;
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
}

function describeUnsupportedContent(content: unknown): string {
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
