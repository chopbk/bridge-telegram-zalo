import express from 'express';
import { getEnv } from './config/env.js';
import logger from './config/logger.js';
import { getDb } from './db/client.js';
import { createZaloAdapter } from './zalo/factory.js';
import { wireInbound } from './bridge/inbound.js';
import { createTelegramBot, startTelegramBot } from './telegram/bot.js';
import { setNotifyApi } from './telegram/notify.js';

async function main(): Promise<void> {
  const env = getEnv();
  getDb();

  const { adapter, botAdapter } = createZaloAdapter();
  const telegramBot = createTelegramBot(adapter);
  setNotifyApi(telegramBot.api);

  wireInbound(telegramBot.api, adapter);
  await adapter.start();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      mode: adapter.mode,
      uptime: process.uptime(),
    });
  });

  if (botAdapter) {
    botAdapter.mountWebhook(app);
  }

  await new Promise<void>((resolve) => {
    app.listen(env.PORT, () => {
      logger.info({ port: env.PORT, mode: adapter.mode }, 'HTTP server listening');
      resolve();
    });
  });

  // Start Telegram polling (blocks)
  await startTelegramBot(telegramBot);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
