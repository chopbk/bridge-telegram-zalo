# tg-zalo

Bridge **Telegram ↔ Zalo**: one forum topic per customer, topic replies go to Zalo, channel posts broadcast to approved customers.

- Spec: [SPEC.md](./SPEC.md)
- Vietnamese guide: [docs/README.vi.md](./docs/README.vi.md)

## Requirements

- Node.js ≥ **22.5** (uses built-in `node:sqlite`; 22/24 LTS recommended)
- Telegram bot + **Topics-enabled supergroup** + **channel** (bot must be admin)
- **`TELEGRAM_ADMIN_IDS` required** (comma-separated Telegram user ids)
- `personal` mode (**MVP first**): secondary Zalo account + `npm run zalo:login`
- `bot` mode: Zalo Bot token; production webhook needs `ZALO_BOT_WEBHOOK_SECRET`

## Quick start

```bash
cp .env.example .env
# fill TELEGRAM_* (including ADMIN_IDS) and credentials for your chosen mode
npm install
npm run zalo:login   # personal mode
npm run dev
```

### Zalo personal mode (recommended MVP)

```env
ZALO_MODE=personal
ZALO_SESSION_PATH=./data/zalo-session.json
ZALO_MIN_SEND_INTERVAL_MS=1500
ZALO_SEND_MAX_PER_MINUTE=20
TELEGRAM_ADMIN_IDS=123456789
```

```bash
npm run zalo:login   # scan QR → save session
npm run dev
```

Use a **secondary** Zalo account. Unofficial automation (`zca-js`) can get accounts restricted. Min-interval + max-per-minute reduce blast risk.

### Zalo Bot mode

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=...
PORT=3080
```

**Local / dev (default):** long polling via `getUpdates`.

**Production:** webhook + HTTPS + `ZALO_BOT_WEBHOOK_SECRET` (`X-Zalo-Bot-Api-Secret-Token`).

Customers must message the Zalo bot once before they can receive messages.

## Customer registration

1. Customer texts Zalo: `đăng ký` / `dang ky` / `/start`
2. Bridge opens a topic as **pending** and notifies admins in-topic
3. Admin runs `/approve` or `/reject` inside the topic
4. Only **approved**, unmuted, unblocked customers receive channel broadcasts
5. Unsubscribe: `hủy đăng ký` / `huy dang ky` / `/stop`

Admin `/mute` only pauses broadcast — it is not the same as customer unsubscribe.

## Admin commands (Telegram)

Only inside the **forum group**, and only users in `TELEGRAM_ADMIN_IDS`. Use `/help` for a quick cheat sheet.

### Zalo user list & CRUD

| Command | Description |
|---------|-------------|
| `/users` | Users who have chatted (shows copyable `zalo=…`) |
| `/users allowed` | Allowlist only (approved) |
| `/users pending` | Pending approval |
| `/users ids` | Zalo IDs only (easy to copy) |
| `/users 2` | Page 2 |
| `/user <zalo_id>` | One customer detail (or `/user` inside topic) |
| `/user_add <zalo_id> [name]` | Add to allowlist + create topic |
| `/user_edit <zalo_id> name=… status=approved muted=0 blocked=0` | Edit |
| `/user_del <zalo_id>` | Delete from DB (+ topic best-effort) |
| `/search <query>` | Search by name / Zalo id |
| `/list [page] [status]` | Legacy list alias |

### Approve / block

| Command | Description |
|---------|-------------|
| `/approve` `/reject` `[zalo_id]` | In topic **or** with id |
| `/block` `/unblock` `[zalo_id]` | Hard block |
| `/mute` `/unmute` `[zalo_id]` | Pause / resume broadcast |

### System

| Command | Description |
|---------|-------------|
| `/mode` `/status` | Mode / stats |
| `/recreate` | Recreate deleted forum topic |
| `/retry_broadcast <jobId>` | Resend failed broadcast items |

Topic text replies forward to Zalo **only for admins**, and only when the customer is approved.

## Message flows

| Flow | Behavior |
|------|----------|
| A | Customer → Zalo → topic; register/unsubscribe; unsupported media → notify topic |
| B | Admin reply in topic → Zalo (if approved) |
| C | Channel text → SQLite jobs fan-out + admin report (ok/fail) |

MVP **sends** text only; inbound non-text is reported on Telegram.

## Reliability

- Inbound dedup by `(provider, message_id)`
- Broadcast jobs in SQLite with limited retries; resume after restart
- Mapping keyed by `(provider, zalo_user_id)`

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
