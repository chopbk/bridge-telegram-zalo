import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { imageSize } from 'image-size';
import logger from '../config/logger.js';
import type { ZaloImageAttachment } from '../zalo/types.js';
import { getSessionDownloadHeaders } from '../zalo/personal/session.js';

export async function downloadToBuffer(
  url: string,
  headers?: Record<string, string>,
): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        headers?.['User-Agent'] ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      ...headers,
    },
    redirect: 'follow',
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
