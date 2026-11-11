import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { imageSize } from 'image-size';
import { Zalo, type API, type Credentials } from 'zca-js';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';

async function imageMetadataGetter(filePath: string) {
  try {
    const data = await readFile(filePath);
    const dim = imageSize(data);
    if (!dim.width || !dim.height) return null;
    return { width: dim.width, height: dim.height, size: data.length };
  } catch (err) {
    logger.warn({ err, filePath }, 'imageMetadataGetter failed');
    return null;
  }
}

export type ZaloSessionFile = {
  cookie: Credentials['cookie'];
  imei: string;
  userAgent: string;
  language?: string;
};

let apiSingleton: API | null = null;
let loginPromise: Promise<API> | null = null;

export async function saveSessionAtomic(
  session: ZaloSessionFile,
  pathOverride?: string,
): Promise<string> {
  const path = pathOverride ?? getEnv().ZALO_SESSION_PATH;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

export async function loadSession(pathOverride?: string): Promise<ZaloSessionFile> {
  const path = pathOverride ?? getEnv().ZALO_SESSION_PATH;
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ZaloSessionFile>;
  if (!parsed.cookie || !parsed.imei || !parsed.userAgent) {
    throw new Error(`Invalid Zalo session at ${path}: missing cookie/imei/userAgent`);
  }
  return {
    cookie: parsed.cookie,
    imei: parsed.imei,
    userAgent: parsed.userAgent,
    language: parsed.language,
  };
}

/** Cookie header để tải media CDN Zalo */
export function cookieHeaderFromSession(session: ZaloSessionFile): string {
  const c = session.cookie as unknown;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const row = item as { key?: string; value?: string; name?: string };
        const key = row.key ?? row.name;
        if (!key || row.value == null) return '';
        return `${key}=${row.value}`;
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

export async function getSessionDownloadHeaders(): Promise<Record<string, string>> {
  const session = await loadSession();
  const headers: Record<string, string> = {
    'User-Agent': session.userAgent || 'Mozilla/5.0',
    Referer: 'https://chat.zalo.me/',
    Origin: 'https://chat.zalo.me',
  };
  const cookie = cookieHeaderFromSession(session);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export function resetZaloClient(): void {
  apiSingleton = null;
  loginPromise = null;
}

export async function getZaloApi(): Promise<API> {
  if (apiSingleton) return apiSingleton;
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const session = await loadSession();
    // selfListen: nhận cả tin do chính tài khoản gửi (để forward ngữ cảnh lên Telegram)
    const zalo = new Zalo({ imageMetadataGetter, selfListen: true });
    const api = await zalo.login({
      cookie: session.cookie,
      imei: session.imei,
      userAgent: session.userAgent,
      language: session.language,
    });
    apiSingleton = api;
    logger.info({ event: 'zalo_session_loaded' }, 'Zalo personal client ready');
    return api;
  })();

  try {
    return await loginPromise;
  } catch (err) {
    loginPromise = null;
    apiSingleton = null;
    throw err;
  }
}
