import {
  parseZaloStylesPayload,
  type TextStyleSpan,
} from '../../bridge/format.js';

export type ExtractedRtf = {
  text: string;
  styles: TextStyleSpan[];
};

/**
 * Tin rich-text Zalo (`action: "rtf"`): nội dung nằm ở `title`, style ở `params`.
 * Không phải link — href/thumb thường rỗng.
 */
export function extractRtfMessage(content: unknown): ExtractedRtf | null {
  if (!content || typeof content !== 'object') return null;
  const obj = content as Record<string, unknown>;
  if (String(obj.action ?? '') !== 'rtf') return null;

  const text = typeof obj.title === 'string' ? obj.title : '';
  if (!text.trim()) return null;

  return {
    text,
    styles: parseZaloStylesPayload(obj.params),
  };
}
