import { ThreadType, type API, type ZaloListenerMessage } from 'zca-js';
import logger from '../../config/logger.js';

export type MediaStoreType = 'media' | 'file' | 'link';

export type MediaStoreItem = {
  id?: number | string;
  type?: string;
  sub_type?: number;
  owner_id?: string;
  owner_name?: string;
  group_id?: string;
  global_msg_id?: string | number;
  client_msg_id?: string | number;
  title?: string;
  src_url?: string;
  thumb_url?: string;
  previewThumb?: string | null;
  created_time?: number;
  duration?: number;
  file_size?: number;
};

type MediaStoreResponse = {
  items?: MediaStoreItem[];
  isLimitPermission?: boolean;
  last_id?: number | string;
  has_more?: number | boolean;
};

type GetConversationMediaFn = (options: {
  groupId: string;
  mediaType?: MediaStoreType;
  limit?: number;
  lastId?: number | string;
}) => Promise<MediaStoreResponse>;

const MEDIA_TYPES: MediaStoreType[] = ['media', 'file', 'link'];

/**
 * Đăng ký api.getConversationMedia qua api.custom (zca-js không ship sẵn).
 * Endpoint: /api/mediastore/list — Kho ảnh/file/link của group.
 */
export function ensureGetConversationMedia(api: API): GetConversationMediaFn | null {
  const existing = (api as API & { getConversationMedia?: GetConversationMediaFn })
    .getConversationMedia;
  if (typeof existing === 'function') return existing.bind(api);

  if (typeof api.custom !== 'function') return null;

  try {
    api.custom('getConversationMedia', async ({ ctx, utils, props }) => {
      const options = (props ?? {}) as {
        groupId?: string;
        mediaType?: MediaStoreType;
        limit?: number;
        lastId?: number | string;
      };
      const rawGroupId = options.groupId;
      if (!rawGroupId) throw new Error('Missing groupId');
      const groupId = rawGroupId.startsWith('g') ? rawGroupId.slice(1) : rawGroupId;

      const hosts = api.zpwServiceMap?.media_store;
      const host = Array.isArray(hosts) ? hosts[0] : undefined;
      if (!host) throw new Error('media_store host missing in zpwServiceMap');

      const serviceURL = utils.makeURL(`${host}/api/mediastore/list`);
      const params: Record<string, unknown> = {
        media_type: options.mediaType ?? 'media',
        group_id: groupId,
        limit: options.limit ?? 20,
        imei: ctx.imei,
      };
      if (options.lastId !== undefined) params.last_id = options.lastId;

      const encryptedParams = utils.encodeAES(JSON.stringify(params));
      if (!encryptedParams) throw new Error('Failed to encrypt media store params');

      const response = await utils.request(
        utils.makeURL(serviceURL, { params: encryptedParams }),
        { method: 'GET' },
      );
      return utils.resolve(response) as Promise<MediaStoreResponse>;
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to register getConversationMedia');
    return null;
  }

  const fn = (api as API & { getConversationMedia?: GetConversationMediaFn })
    .getConversationMedia;
  return typeof fn === 'function' ? fn.bind(api) : null;
}

/**
 * Khi Cloud Message trống: lấy ảnh/file/link từ Media Store → giả lập listener msgs.
 */
export async function fetchGroupMediaStoreMessages(
  api: API,
  groupId: string,
  count: number,
): Promise<{ msgs: ZaloListenerMessage[]; pages: number }> {
  const getMedia = ensureGetConversationMedia(api);
  if (!getMedia) return { msgs: [], pages: 0 };

  const want = Math.max(1, Math.min(count, 200));
  const collected: ZaloListenerMessage[] = [];
  const seen = new Set<string>();
  let pages = 0;

  for (const mediaType of MEDIA_TYPES) {
    if (collected.length >= want) break;
    let lastId: number | string | undefined;
    for (let page = 0; page < 5 && collected.length < want; page++) {
      let res: MediaStoreResponse;
      try {
        res = await getMedia({
          groupId,
          mediaType,
          limit: Math.min(50, want - collected.length + 5),
          lastId,
        });
      } catch (err) {
        logger.warn({ err, groupId, mediaType }, 'getConversationMedia failed');
        break;
      }
      pages += 1;
      const items = res.items ?? [];
      if (!items.length) break;

      for (const item of items) {
        const msg = mediaItemToListenerMessage(groupId, item);
        if (!msg) continue;
        const id = msg.data.msgId != null ? String(msg.data.msgId) : '';
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        collected.push(msg);
        if (collected.length >= want) break;
      }

      const nextId = res.last_id;
      const hasMore = Number(res.has_more ?? 0) === 1;
      if (!hasMore || nextId == null || nextId === lastId) break;
      lastId = nextId;
    }
  }

  logger.info(
    { groupId, want, got: collected.length, pages },
    'Fetched group history from Media Store fallback',
  );
  return { msgs: collected, pages };
}

function mediaItemToListenerMessage(
  groupId: string,
  item: MediaStoreItem,
): ZaloListenerMessage | null {
  const src =
    typeof item.src_url === 'string' && /^https?:\/\//i.test(item.src_url)
      ? item.src_url
      : '';
  const thumb =
    typeof item.thumb_url === 'string' && /^https?:\/\//i.test(item.thumb_url)
      ? item.thumb_url
      : typeof item.previewThumb === 'string' && /^https?:\/\//i.test(item.previewThumb)
        ? item.previewThumb
        : undefined;
  if (!src && !thumb) return null;

  const msgId = String(item.global_msg_id ?? item.id ?? '');
  if (!msgId) return null;

  const kind = (item.type || '').toLowerCase();
  const duration = item.duration != null ? Number(item.duration) : undefined;
  const isVideo = kind === 'media' && duration != null && duration > 0;
  const title = typeof item.title === 'string' ? item.title.trim() : '';

  let msgType: string;
  let content: Record<string, unknown>;

  if (kind === 'media' && !isVideo && src) {
    msgType = 'chat.photo';
    content = {
      href: src,
      thumb: thumb ?? src,
      title: title || undefined,
    };
  } else if (kind === 'link' || isVideo || kind === 'file') {
    msgType = 'chat.link';
    const href = src || thumb || '';
    if (!href) return null;
    content = {
      href,
      title:
        title ||
        (isVideo ? 'Video' : kind === 'file' ? 'File' : undefined),
      thumb,
    };
  } else {
    return null;
  }

  return {
    type: ThreadType.Group,
    threadId: groupId,
    data: {
      msgId,
      cliMsgId:
        item.client_msg_id != null ? String(item.client_msg_id) : msgId,
      ts: item.created_time,
      uidFrom: item.owner_id != null ? String(item.owner_id) : undefined,
      dName: typeof item.owner_name === 'string' ? item.owner_name : undefined,
      msgType,
      content,
    },
  };
}
