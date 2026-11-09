import { isPhotoMsgType } from './photo.js';

export type ExtractedLink = {
  href: string;
  title?: string;
  description?: string;
  thumb?: string;
};

/**
 * Link preview / share card từ Zalo personal (`title` + `href` ± `thumb`).
 * Không lấy chat.photo / chat.recommended (contact card).
 */
export function extractLinkAttachment(
  content: unknown,
  msgType?: string,
): ExtractedLink | null {
  if (!content || typeof content !== 'object') return null;
  if (isPhotoMsgType(msgType)) return null;
  if (msgType && /recommended/i.test(msgType)) return null;

  const obj = content as Record<string, unknown>;
  if (typeof obj.type === 'string' && obj.type.toLowerCase() === 'photo') {
    return null;
  }

  const href = typeof obj.href === 'string' ? obj.href.trim() : '';
  if (!/^https?:\/\//i.test(href)) return null;

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawDesc = typeof obj.description === 'string' ? obj.description.trim() : '';
  // Contact card nhét JSON vào description — bỏ qua
  const description =
    rawDesc && !rawDesc.startsWith('{') && !rawDesc.startsWith('[')
      ? rawDesc
      : '';

  const thumb =
    typeof obj.thumb === 'string' && /^https?:\/\//i.test(obj.thumb)
      ? obj.thumb
      : undefined;

  const looksLikeImageFile = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(href);
  // Chỉ còn URL ảnh thuần (không title/desc) → để photo path / unsupported xử lý
  if (!title && !description && looksLikeImageFile) return null;

  return {
    href,
    title: title || undefined,
    description: description || undefined,
    thumb,
  };
}

export function formatLinkText(link: ExtractedLink): string {
  const lines: string[] = [];
  if (link.title) lines.push(link.title);
  if (link.description && link.description !== link.title) {
    lines.push(link.description);
  }
  if (!lines.includes(link.href)) lines.push(link.href);
  return lines.join('\n');
}
