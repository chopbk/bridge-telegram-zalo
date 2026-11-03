import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';

let apiRef: Api | null = null;

export function setNotifyApi(api: Api): void {
  apiRef = api;
}

export async function notifyAdmins(text: string): Promise<void> {
  if (!apiRef) return;
  const admins = getEnv().telegramAdminIds;
  if (admins.length === 0) {
    logger.warn({ text }, 'Admin notify skipped — TELEGRAM_ADMIN_IDS empty');
    return;
  }
  for (const id of admins) {
    try {
      await apiRef.sendMessage(id, text);
    } catch (err) {
      logger.error({ err, adminId: id }, 'Failed to notify admin');
    }
  }
}
