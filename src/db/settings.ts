import { getEnv } from '../config/env.js';
import { getDb } from './client.js';

const KEY_SIGNATURE_ENABLED = 'forward_signature_enabled';
const KEY_SIGNATURE_TEXT = 'forward_signature_text';

function nowIso(): string {
  return new Date().toISOString();
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

export function deleteSetting(key: string): void {
  getDb().prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
}

export type SignatureConfig = {
  enabled: boolean;
  text: string;
};

/** Chữ ký chỉ cho broadcast channel→Zalo. DB ghi đè env FORWARD_SIGNATURE. */
export function getSignatureConfig(): SignatureConfig {
  const envDefault = (getEnv().FORWARD_SIGNATURE ?? '').trim();
  const storedText = getSetting(KEY_SIGNATURE_TEXT);
  const text = (storedText ?? envDefault).trim();
  const enabledRaw = getSetting(KEY_SIGNATURE_ENABLED);
  const enabled =
    enabledRaw == null ? text.length > 0 : enabledRaw === '1' || enabledRaw === 'true';
  return { enabled: enabled && text.length > 0, text };
}

export function setSignatureText(text: string): SignatureConfig {
  const trimmed = text.trim();
  setSetting(KEY_SIGNATURE_TEXT, trimmed);
  setSetting(KEY_SIGNATURE_ENABLED, trimmed ? '1' : '0');
  return getSignatureConfig();
}

export function setSignatureEnabled(enabled: boolean): SignatureConfig {
  setSetting(KEY_SIGNATURE_ENABLED, enabled ? '1' : '0');
  return getSignatureConfig();
}

/** Ghép chữ ký vào cuối nội dung (plain). */
export function appendSignaturePlain(body: string): string {
  const { enabled, text } = getSignatureConfig();
  if (!enabled || !text) return body;
  const base = body.trimEnd();
  if (!base) return `— ${text}`;
  return `${base}\n\n— ${text}`;
}

/** Ghép chữ ký HTML (Telegram parse_mode=HTML). */
export function appendSignatureHtml(bodyHtml: string): string {
  const { enabled, text } = getSignatureConfig();
  if (!enabled || !text) return bodyHtml;
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const base = bodyHtml.trimEnd();
  if (!base) return `— ${escaped}`;
  return `${base}\n\n— ${escaped}`;
}
