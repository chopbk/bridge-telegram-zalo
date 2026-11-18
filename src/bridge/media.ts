import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import { imageSize } from 'image-size';
import logger from '../config/logger.js';
import type { ZaloImageAttachment } from '../zalo/types.js';
import { getSessionDownloadHeaders } from '../zalo/personal/session.js';

// Telegram hay timeout trên IPv6 ở một số mạng — ưu tiên IPv4
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore older node
}

export type DownloadOpts = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Ép IPv4 (tránh hang Happy Eyeballs / IPv6). Mặc định true với host telegram. */
  forceIpv4?: boolean;
};

function shouldForceIpv4(url: string, explicit?: boolean): boolean {
  if (explicit != null) return explicit;
  try {
    const host = new URL(url).hostname;
    return /telegram\.org$/i.test(host) || /telesco\.pe$/i.test(host);
  } catch {
    return false;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number | string; message?: string };
  return (
    e.name === 'AbortError' ||
    e.code === 20 ||
    e.code === 'ABORT_ERR' ||
    /aborted|timeout/i.test(String(e.message ?? ''))
  );
}

/** Tải HTTP(S) ép IPv4 — ổn định hơn fetch khi Telegram IPv6 bị treo. */
function downloadViaIpv4(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  redirectsLeft = 5,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        family: 4,
        servername: parsed.hostname,
        headers: {
          'User-Agent':
            headers?.['User-Agent'] ??
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects: ${url.slice(0, 120)}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          downloadViaIpv4(next, headers, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Download failed ${status}: ${url.slice(0, 120)}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) {
            reject(new Error(`Download empty body: ${url.slice(0, 120)}`));
            return;
          }
          resolve(buf);
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`IPv4 download timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

export async function downloadToBuffer(
  url: string,
  headersOrOpts?: Record<string, string> | DownloadOpts,
): Promise<Buffer> {
  const opts: DownloadOpts =
    headersOrOpts && ('headers' in headersOrOpts || 'timeoutMs' in headersOrOpts || 'retries' in headersOrOpts || 'forceIpv4' in headersOrOpts)
      ? (headersOrOpts as DownloadOpts)
      : { headers: headersOrOpts as Record<string, string> | undefined };

  const headers = opts.headers;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const retries = Math.max(1, opts.retries ?? 3);
  const forceIpv4 = shouldForceIpv4(url, opts.forceIpv4);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Telegram: ưu tiên IPv4 ngay từ đầu (fetch đôi khi abort dù curl OK)
      if (forceIpv4) {
        return await downloadViaIpv4(url, headers, timeoutMs);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent':
              headers?.['User-Agent'] ??
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            ...headers,
          },
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Download failed ${res.status}: ${url.slice(0, 120)}`);
        }
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length === 0) {
          throw new Error(`Download empty body: ${url.slice(0, 120)}`);
        }
        return buf;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, attempt, retries, forceIpv4, url: url.slice(0, 80) },
        'downloadToBuffer attempt failed',
      );
      // Abort/timeout → thử IPv4 cứng ở lần sau
      if (!forceIpv4 && isAbortError(err) && attempt < retries) {
        try {
          logger.warn({ url: url.slice(0, 80) }, 'Retry download via forced IPv4');
          return await downloadViaIpv4(url, headers, timeoutMs);
        } catch (ipv4Err) {
          lastErr = ipv4Err;
        }
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Download failed after ${retries} attempts`);
}

/** Tải ảnh Zalo CDN (kèm cookie session nếu có). */
export async function downloadZaloMedia(url: string): Promise<Buffer> {
  let headers: Record<string, string> = {};
  try {
    headers = await getSessionDownloadHeaders();
  } catch (err) {
    logger.warn({ err }, 'No Zalo session for media download — trying bare fetch');
  }
  try {
    return await downloadToBuffer(url, headers);
  } catch (err) {
    // Retry không cookie nếu lần 1 fail
    if (Object.keys(headers).length > 0) {
      logger.warn({ err, url: url.slice(0, 80) }, 'Zalo media download with cookie failed — retry bare');
      return await downloadToBuffer(url);
    }
    throw err;
  }
}

export async function telegramFileUrl(botToken: string, filePath: string): Promise<string> {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

/** Build Zalo attachment from raw image bytes. */
export function bufferToZaloImage(
  data: Buffer,
  filename = 'photo.jpg',
): ZaloImageAttachment {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let width = 800;
  let height = 800;
  try {
    const dim = imageSize(buf);
    if (dim.width) width = dim.width;
    if (dim.height) height = dim.height;
  } catch (err) {
    logger.warn({ err }, 'image-size failed — using default dimensions');
  }
  const base = filename.replace(/[^\w.\-]+/g, '_') || 'photo.jpg';
  let withExt = base.includes('.') ? base : `${base}.jpg`;
  // zca-js chỉ nhận jpg/jpeg/png/webp cho ảnh
  const ext = withExt.split('.').pop()?.toLowerCase() ?? 'jpg';
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    withExt = `${withExt.replace(/\.[^.]+$/, '')}.jpg`;
  }
  const filenameTyped = withExt as `${string}.${string}`;
  return {
    data: buf,
    filename: filenameTyped,
    metadata: { totalSize: buf.length, width, height },
  };
}

export async function writeTempImage(data: Buffer, ext = 'jpg'): Promise<string> {
  const dir = join(tmpdir(), 'tg-zalo-media');
  await mkdir(dir, { recursive: true });
  const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext.toLowerCase())
    ? ext.toLowerCase()
    : 'jpg';
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.${safeExt}`);
  await writeFile(path, data);
  return path;
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
