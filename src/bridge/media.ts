import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { imageSize } from 'image-size';
import logger from '../config/logger.js';
import type { ZaloImageAttachment } from '../zalo/types.js';

export async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${url.slice(0, 120)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function telegramFileUrl(botToken: string, filePath: string): Promise<string> {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

/** Build Zalo attachment from raw image bytes (avoids sharp / path-only getter). */
export function bufferToZaloImage(
  data: Buffer,
  filename = 'photo.jpg',
): ZaloImageAttachment {
  let width = 800;
  let height = 800;
  try {
    const dim = imageSize(data);
    if (dim.width) width = dim.width;
    if (dim.height) height = dim.height;
  } catch (err) {
    logger.warn({ err }, 'image-size failed — using default dimensions');
  }
  const base = filename.replace(/[^\w.\-]+/g, '_') || 'photo.jpg';
  const withExt = base.includes('.') ? base : `${base}.jpg`;
  const filenameTyped = withExt as `${string}.${string}`;
  return {
    data,
    filename: filenameTyped,
    metadata: { totalSize: data.length, width, height },
  };
}

export async function writeTempImage(data: Buffer, ext = 'jpg'): Promise<string> {
  const dir = join(tmpdir(), 'tg-zalo-media');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
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
