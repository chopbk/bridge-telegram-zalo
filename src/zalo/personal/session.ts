import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Zalo, type API, type Credentials } from 'zca-js';
import { getEnv } from '../../config/env.js';
import logger from '../../config/logger.js';

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

export function resetZaloClient(): void {
  apiSingleton = null;
  loginPromise = null;
}

export async function getZaloApi(): Promise<API> {
  if (apiSingleton) return apiSingleton;
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const session = await loadSession();
    const zalo = new Zalo();
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
