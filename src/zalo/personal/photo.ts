import type { InboundImage } from '../types.js';

function isPhotoMsgType(msgType?: string): boolean {
  if (!msgType) return false;
  const t = msgType.toLowerCase();
  return t === 'chat.photo' || t.includes('photo') || t === 'chat.doodle';
}

function collectUrlsFromParams(params: unknown, into: Set<string>): void {
  if (params == null) return;
  let obj: Record<string, unknown> | null = null;
  if (typeof params === 'string' && params.trim()) {
    try {
      obj = JSON.parse(params) as Record<string, unknown>;
    } catch {
      return;
    }
  } else if (typeof params === 'object') {
    obj = params as Record<string, unknown>;
  }
  if (!obj) return;
  for (const key of ['hd', 'oriUrl', 'normalUrl', 'url', 'href', 'thumbUrl']) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) into.add(v);
  }
}

/**
 * Extract downloadable image URL(s) from a Zalo personal listener message.
 */
export function extractInboundImages(
  content: unknown,
  msgType?: string,
): InboundImage[] | null {
  if (!content || typeof content !== 'object') return null;
  const obj = content as Record<string, unknown>;

  const hasHref = typeof obj.href === 'string' && /^https?:\/\//i.test(obj.href);
  const hasThumb =
    typeof obj.thumb === 'string' && /^https?:\/\//i.test(String(obj.thumb));

  if (msgType && !isPhotoMsgType(msgType)) return null;

  // Không có msgType: heuristic href+thumb
  if (!msgType && !(hasHref && hasThumb)) return null;

  const urls = new Set<string>();
  collectUrlsFromParams(obj.params, urls);

  if (hasHref) urls.add(obj.href as string);
  if (urls.size === 0 && hasThumb) urls.add(String(obj.thumb));

  if (urls.size === 0) return null;

  // Ưu tiên hd/ori đã add trước trong collectUrlsFromParams
  const ordered = [...urls];
  return [{ url: ordered[0]! }];
}

export function captionFromPhotoContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (typeof obj.title === 'string' && obj.title.trim() && !/^https?:\/\//i.test(obj.title)) {
    return obj.title.trim();
  }
  if (typeof obj.description === 'string' && obj.description.trim()) {
    return obj.description.trim();
  }
  return '';
}
