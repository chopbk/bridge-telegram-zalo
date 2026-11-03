# tg-zalo

Bridge **Telegram ↔ Zalo**: one forum topic per customer, topic replies go to Zalo, channel posts broadcast to all active customers.

- Spec: [SPEC.md](./SPEC.md)
- Vietnamese guide: [docs/README.vi.md](./docs/README.vi.md)

## Requirements

- Node.js ≥ **22.5** (uses built-in `node:sqlite`; 22/24 LTS recommended)
- Telegram bot + **Topics-enabled supergroup** + **channel** (bot must be admin)
- `bot` mode: Zalo Bot token + public HTTPS webhook
- `personal` mode: secondary Zalo account + `npm run zalo:login`

## Quick start

```bash
cp .env.example .env
# fill TELEGRAM_* and credentials for your chosen mode
npm install
npm run dev
```

### Zalo Bot mode

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=...
PORT=3080
```

**Local / dev (default):** long polling via `getUpdates` — no public HTTPS needed.

```env
# optional; auto = polling when NODE_ENV != production
ZALO_BOT_TRANSPORT=polling
```

**Production:** set webhook transport and expose HTTPS:

```env
NODE_ENV=production
ZALO_BOT_TRANSPORT=webhook
ZALO_BOT_WEBHOOK_PATH=/webhooks/zalo
```

Point Nginx HTTPS to `http://127.0.0.1:3080`, then `setWebhook` to `https://your-domain/webhooks/zalo`.

Polling and webhook are mutually exclusive; starting in polling mode calls `deleteWebhook` first.

Customers must message the Zalo bot once before they can receive messages.

### Zalo personal mode

```env
ZALO_MODE=personal
ZALO_SESSION_PATH=./data/zalo-session.json
ZALO_MIN_SEND_INTERVAL_MS=1500
```

```bash
npm run zalo:login   # scan QR → save session
npm run dev
```

Use a **secondary** Zalo account. Unofficial automation (`zca-js`) can get accounts restricted.

## Admin commands (Telegram)

Only users listed in `TELEGRAM_ADMIN_IDS` (empty = allow everyone; for local/dev only):

| Command | Description |
|---------|-------------|
| `/mode` | Active Zalo mode |
| `/status` | Customer count / broadcast targets |
| `/list` | Customer list |
| `/mute` | Mute broadcast (**run inside** the customer topic) |
| `/unmute` | Unmute |

## Message flows

| Flow | Behavior |
|------|----------|
| A | Customer → Zalo → creates/opens Telegram topic |
| B | Admin reply in topic → Zalo customer |
| C | Text post on configured channel → fan-out to active, unmuted customers |

MVP is **text only**.

## Production

```bash
npm run build
npm run pm2:start
```

`ecosystem.config.cjs` uses **1 instance, fork mode** (required for personal Zalo sessions).

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Dev watch |
| `npm run build` / `start` | Build & run `dist/` |
| `npm test` | Vitest |
| `npm run zalo:login` | Personal QR login |

## License

Private / unlicensed unless you add one.
