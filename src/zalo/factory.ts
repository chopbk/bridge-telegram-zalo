import { getEnv } from '../config/env.js';
import { ZaloBotAdapter } from './bot/adapter.js';
import { ZaloPersonalAdapter } from './personal/adapter.js';
import type { ZaloAdapter } from './types.js';

export type CreatedAdapter = {
  adapter: ZaloAdapter;
  botAdapter: ZaloBotAdapter | null;
};

export function createZaloAdapter(): CreatedAdapter {
  const mode = getEnv().ZALO_MODE;
  if (mode === 'bot') {
    const botAdapter = new ZaloBotAdapter();
    return { adapter: botAdapter, botAdapter };
  }
  return { adapter: new ZaloPersonalAdapter(), botAdapter: null };
}
