import type { Api } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';

let apiRef: Api | null = null;

export function setNotifyApi(api: Api): void {
  apiRef = api;
}

export async function notifyAdmins(text: string): Promise<void> {
  if (!apiRef) return;
  const env = getEnv();
  const admins = env.telegramAdminIds;
  let anyOk = false;
  for (const id of admins) {
    try {
      await apiRef.sendMessage(id, text);
      anyOk = true;
    } catch (err) {
      logger.warn({ err, adminId: id }, 'Failed to DM admin — will try forum fallback');
    }
  }
  // Admin chưa /start bot → 403; gửi vào forum group thay thế
  if (!anyOk && env.telegramForumGroupId) {
    try {
      await apiRef.sendMessage(env.telegramForumGroupId, `🔔 Admin:\n${text}`);
      anyOk = true;
    } catch (err) {
      logger.error({ err }, 'Failed to notify via forum group');
    }
  }
  if (!anyOk) {
    logger.warn({ text: text.slice(0, 120) }, 'Admin notify failed entirely');
  }
}
