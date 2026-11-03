import { LoginQRCallbackEventType, Zalo } from 'zca-js';
import { getEnv } from '../../config/env.js';
import { saveSessionAtomic } from './session.js';

async function main(): Promise<void> {
  // Minimal env for login: only need session path (+ dummy mode fields via process.env)
  if (!process.env.ZALO_MODE) process.env.ZALO_MODE = 'personal';
  if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = 'login-placeholder';
  if (!process.env.TELEGRAM_FORUM_GROUP_ID) process.env.TELEGRAM_FORUM_GROUP_ID = '0';
  if (!process.env.TELEGRAM_CHANNEL_ID) process.env.TELEGRAM_CHANNEL_ID = '0';

  const path = getEnv().ZALO_SESSION_PATH;
  console.log('Generating QR...');
  console.log(`Session will be saved to ${path}`);
  console.log('WARNING: unofficial Zalo automation — use a dedicated secondary account.\n');

  const zalo = new Zalo();
  let saved = false;

  const api = await zalo.loginQR({}, (event) => {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        console.log('Waiting for QR scan...');
        void event.actions.saveToFile('./data/zalo-qr.png').then(() => {
          console.log('QR image saved to ./data/zalo-qr.png');
        });
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        console.log(`QR scanned (${event.data.display_name || 'user'})...`);
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        console.log('QR expired. Retrying...');
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        console.error('QR declined.');
        break;
      case LoginQRCallbackEventType.GotLoginInfo:
        void (async () => {
          await saveSessionAtomic({
            cookie: event.data.cookie,
            imei: event.data.imei,
            userAgent: event.data.userAgent,
          });
          saved = true;
          console.log(`Login OK. Session saved to ${path}`);
        })();
        break;
      default:
        break;
    }
  });

  if (!api) throw new Error('Login QR failed');

  try {
    api.listener.stop();
  } catch {
    // ignore
  }

  await new Promise((r) => setTimeout(r, 400));
  if (!saved) {
    console.warn('Session may not have been saved. Re-run if needed.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('zalo:login failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
