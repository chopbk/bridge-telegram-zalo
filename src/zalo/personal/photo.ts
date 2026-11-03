import type { InboundImage } from '../types.js';

/**
 * Extract downloadable image URL(s) from a Zalo personal listener message.
 * Photos usually arrive as msgType `chat.photo` with TAttachmentContent
 * (href/thumb + params JSON that may contain `hd`).
 */
export function extractInboundImages(
  content: unknown,
  msgType?: string,
): InboundImage[] | null {
  if (!content || typeof content !== 'object') return null;
  const obj = content as Record<string, unknown>;

  if (msgType && msgType !== 'chat.photo') return null;

  const hasHref = typeof obj.href === 'string' && /^https?:\/\//i.test(obj.href);
  const hasThumb =
    typeof obj.thumb === 'string' && /^https?:\/\//i.test(String(obj.thumb));

  // Không có msgType: chỉ nhận khi giống attachment ảnh (href + thumb)
  if (!msgType && !(hasHref && hasThumb)) return null;
  if (msgType === 'chat.photo' && !hasHref && !hasThumb && typeof obj.params !== 'string') {
    return null;
  }

  const urls = new Set<string>();

  if (typeof obj.params === 'string' && obj.params.trim()) {
    try {
      const params = JSON.parse(obj.params) as Record<string, unknown>;
      for (const key of ['hd', 'oriUrl', 'normalUrl', 'url', 'href']) {
        const v = params[key];
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) urls.add(v);
      }
    } catch {
      // ignore bad params
    }
  }

  if (hasHref) urls.add(obj.href as string);
  if (urls.size === 0 && hasThumb) urls.add(String(obj.thumb));

  if (urls.size === 0) return null;
  // Một tin Zalo photo thường 1 URL tốt nhất — ưu tiên hd đã add trước
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
