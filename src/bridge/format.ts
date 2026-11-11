/**
 * Chuyển format text giữa Zalo styles và Telegram entities/HTML.
 *
 * Zalo: styles [{ start, len, st }] trong propertyExt.ext / sendMessage.styles
 * Telegram: MessageEntity (UTF-16 offsets) hoặc HTML parse_mode
 */

export type TextStyleSpan = {
  start: number;
  len: number;
  st: string;
};

export type TelegramEntityLike = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

const ZALO_TO_TG: Record<string, 'b' | 'i' | 'u' | 's'> = {
  b: 'b',
  i: 'i',
  u: 'u',
  s: 's',
};

const TG_TO_ZALO: Record<string, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strikethrough: 's',
};

/** Parse styles từ propertyExt của tin Zalo inbound. */
export function parseZaloPropertyStyles(propertyExt: unknown): TextStyleSpan[] {
  if (!propertyExt || typeof propertyExt !== 'object') return [];
  const extRaw = (propertyExt as { ext?: unknown }).ext;
  let parsed: unknown = extRaw;
  if (typeof extRaw === 'string' && extRaw.trim()) {
    try {
      parsed = JSON.parse(extRaw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const styles = (parsed as { styles?: unknown }).styles;
  if (!Array.isArray(styles)) return [];

  const out: TextStyleSpan[] = [];
  for (const item of styles) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const start = Number(s.start);
    const len = Number(s.len);
    const st = typeof s.st === 'string' ? s.st : '';
    if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0 || !st) continue;
    if (start < 0) continue;
    out.push({ start, len, st });
  }
  return out;
}

export function shiftStyles(styles: TextStyleSpan[], offset: number): TextStyleSpan[] {
  if (!offset) return styles.map((s) => ({ ...s }));
  return styles.map((s) => ({ ...s, start: s.start + offset }));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

type FlagKey = 'b' | 'i' | 'u' | 's';

function styleKey(st: string): FlagKey | null {
  if (ZALO_TO_TG[st]) return ZALO_TO_TG[st]!;
  // Một số bản Zalo gửi đầy đủ hơn
  if (st === 'bold') return 'b';
  if (st === 'italic') return 'i';
  if (st === 'underline') return 'u';
  if (st === 'strike' || st === 'strikethrough') return 's';
  return null;
}

/**
 * Render text + Zalo styles → HTML cho Telegram parse_mode=HTML.
 * Chỉ map bold/italic/underline/strikethrough (Telegram hỗ trợ tốt).
 */
export function zaloStylesToTelegramHtml(
  text: string,
  styles: TextStyleSpan[],
): string {
  if (!text) return '';
  if (!styles.length) return escapeHtml(text);

  const n = text.length;
  const flags: Array<Record<FlagKey, boolean>> = Array.from({ length: n }, () => ({
    b: false,
    i: false,
    u: false,
    s: false,
  }));

  for (const span of styles) {
    const key = styleKey(span.st);
    if (!key) continue;
    const from = Math.max(0, Math.min(n, span.start));
    const to = Math.max(from, Math.min(n, span.start + span.len));
    for (let i = from; i < to; i++) flags[i]![key] = true;
  }

  const order: FlagKey[] = ['b', 'i', 'u', 's'];
  const tag: Record<FlagKey, string> = {
    b: 'b',
    i: 'i',
    u: 'u',
    s: 's',
  };

  let out = '';
  let prev: Record<FlagKey, boolean> = { b: false, i: false, u: false, s: false };

  const closeDiff = (cur: Record<FlagKey, boolean>) => {
    for (let i = order.length - 1; i >= 0; i--) {
      const k = order[i]!;
      if (prev[k] && !cur[k]) out += `</${tag[k]}>`;
    }
  };
  const openDiff = (cur: Record<FlagKey, boolean>) => {
    for (const k of order) {
      if (!prev[k] && cur[k]) out += `<${tag[k]}>`;
    }
  };

  for (let i = 0; i < n; i++) {
    const cur = flags[i]!;
    closeDiff(cur);
    openDiff(cur);
    prev = cur;
    out += escapeHtml(text[i]!);
  }
  closeDiff({ b: false, i: false, u: false, s: false });
  return out;
}

/** Telegram entities → Zalo styles (chỉ bold/italic/underline/strike). */
export function telegramEntitiesToZaloStyles(
  text: string,
  entities: TelegramEntityLike[] | undefined,
): TextStyleSpan[] {
  if (!entities?.length || !text) return [];
  const out: TextStyleSpan[] = [];
  for (const e of entities) {
    const st = TG_TO_ZALO[e.type];
    if (!st) continue;
    if (e.offset < 0 || e.length <= 0) continue;
    if (e.offset >= text.length) continue;
    const len = Math.min(e.length, text.length - e.offset);
    if (len <= 0) continue;
    out.push({ start: e.offset, len, st });
  }
  return out;
}
