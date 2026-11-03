# tg-zalo

Bridge **Telegram ↔ Zalo** for customer support and channel broadcasts.

| Direction | What happens |
|-----------|----------------|
| **A** | Zalo (1-1 or group) → one Telegram **forum topic** per mapped id |
| **B** | Admin reply in topic → that Zalo user/group (text + photos) |
| **C** | Telegram **channel** post (text/photo) → fan-out to approved Zalo targets |

- Spec: [SPEC.md](./SPEC.md)
- Tiếng Việt: [docs/README.vi.md](./docs/README.vi.md)
- License: [MIT](./LICENSE)

> **Warning:** Personal mode uses unofficial Zalo automation ([zca-js](https://github.com/RFS-ADRENO/zca-js)). Accounts can be limited or banned. Prefer a **secondary** Zalo account. You are responsible for complying with Telegram, Zalo, and local law.

---

## Features

- **Two Zalo modes** (runtime picks one): `personal` (zca-js, recommended MVP) or official `bot` API
- **Forum inbox**: one topic per Zalo user **or group** (`thread_kind`)
- **Registration flow**: customer `đăng ký` → `pending` → admin `/approve` / `/reject`
- **Allowlist CRUD**: `/useradd`, `/useredit`, `/userdel`, `/users`, `/search`
- **Groups**: map by **group id** (not the member who typed); `/useradd <id> group`
- **Bidirectional photos**: topic ↔ Zalo (single + album); channel photos broadcast too
- **Multi-admin / multi-channel**: comma-separated `TELEGRAM_ADMIN_IDS`, `TELEGRAM_CHANNEL_ID`
- **Broadcast jobs** in SQLite with retry + admin report; `/retrybroadcast`
- **Rate limits** for personal sends (`ZALO_MIN_SEND_INTERVAL_MS`, `ZALO_SEND_MAX_PER_MINUTE`)
- **Helpers**: `telegram:ids` to discover chat ids; `/config` to verify bot rights

---

## Requirements

- **Node.js ≥ 22.5** (built-in `node:sqlite`; 22/24 LTS recommended)
- Telegram bot (BotFather)
- Telegram **supergroup with Topics** enabled; bot is **admin** with manage topics
- One or more Telegram **channels**; bot is admin / can post
- Network that can reach `api.telegram.org` (timeouts are common on some VN ISPs — use VPN/VPS if needed)
- Personal mode: secondary Zalo account + QR login
- Bot mode: Zalo Bot token (+ webhook secret in production)

---

## Quick start

```bash
git clone https://github.com/<your-org>/tg-zalo.git
cd tg-zalo
cp .env.example .env
npm install

# 1) Put TELEGRAM_BOT_TOKEN in .env
# 2) Discover ids (stop any running bridge — same token cannot poll twice)
npm run telegram:ids
# Chat the bot privately → your user id (ADMIN_IDS)
# Add bot to forum group / channel, send /id → FORUM / CHANNEL ids

# 3) Fill .env then:
npm run zalo:login   # personal mode only — scan QR
npm run dev
```

Verify with `/config` in a private chat with the bot (as an admin).

---

## Environment

See [`.env.example`](./.env.example). Important variables:

| Variable | Description |
|----------|-------------|
| `ZALO_MODE` | `personal` \| `bot` |
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `TELEGRAM_FORUM_GROUP_ID` | Forum supergroup id (often `-100…`) |
| `TELEGRAM_CHANNEL_ID` | One or more channel ids, comma-separated |
| `TELEGRAM_ADMIN_IDS` | One or more Telegram **user** ids, comma-separated (**required**) |
| `ZALO_SESSION_PATH` | Personal session JSON (gitignored) |
| `ZALO_MIN_SEND_INTERVAL_MS` | Delay between Zalo sends (default `1500`) |
| `ZALO_SEND_MAX_PER_MINUTE` | Cap sends/minute (default `20`) |
| `ZALO_BOT_TOKEN` | Required if `ZALO_MODE=bot` |
| `ZALO_BOT_TRANSPORT` | `polling` (dev) \| `webhook` (prod) |
| `ZALO_BOT_WEBHOOK_SECRET` | Required for webhook |
| `DATABASE_PATH` | SQLite file (default `./data/bridge.db`) |
| `JOB_MAX_RETRIES` | Broadcast item retries |
| `LIST_PAGE_SIZE` | Pagination for list commands |

Example:

```env
ZALO_MODE=personal
TELEGRAM_BOT_TOKEN=123456:ABC…
TELEGRAM_FORUM_GROUP_ID=-1001234567890
TELEGRAM_CHANNEL_ID=-1001111111111,-1002222222222
TELEGRAM_ADMIN_IDS=111111111,222222222
ZALO_SESSION_PATH=./data/zalo-session.json
ZALO_MIN_SEND_INTERVAL_MS=1500
ZALO_SEND_MAX_PER_MINUTE=20
```

---

## Setup checklist (Telegram)

1. Create bot with [@BotFather](https://t.me/BotFather); disable privacy if you need all group messages (forum admin is enough for topics).
2. Create a **supergroup**, enable **Topics**, add the bot as admin (**Manage Topics**, send messages, etc.).
3. Create channel(s), add the bot as admin.
4. Run `npm run telegram:ids`, collect admin / forum / channel ids into `.env`.
5. Start bridge; DM the bot `/config` — forum & channels should show bot as administrator.

---

## Zalo modes

### Personal (recommended MVP)

```bash
npm run zalo:login   # QR → ./data/zalo-session.json
npm run dev
```

- Uses [zca-js](https://github.com/RFS-ADRENO/zca-js) (unofficial).
- Listener must stay running for inbound + reliable image send.
- Only **one** web session per account — don’t open Zalo Web in parallel.

### Official Bot API

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=…
# local: polling; production: webhook + secret + HTTPS
```

Customers must message the Zalo bot once before they can receive messages. Photo send in bot mode is not fully supported yet — use personal mode for image bridge.

---

## Customer & group lifecycle

### 1-1 users

1. Customer texts Zalo: `đăng ký` / `dang ky` / `/register` / `/start`
2. Bridge creates a forum topic (`pending`) and notifies in-topic
3. Admin: `/approve` or `/reject` (in topic or with `zalo_id`)
4. Only **approved**, not muted, not blocked → receive channel broadcasts
5. Unsubscribe: `hủy đăng ký` / `/stop` → `unsubscribed`
6. Unknown 1-1 chatters get a short register hint on Zalo; **no** auto topic

### Groups

- Map by **Zalo group id**, not the member who sent the message
- Add with `/useradd <group_id> group [name]` (or auto-detect via `getGroupInfo`)
- Topic lines look like: `SenderName: message`
- **No** register / unsubscribe auto-replies inside groups
- Unknown groups are ignored (no spam)

Admin `/mute` only pauses **broadcast**; it is not the same as customer unsubscribe.

---

## Message flows

| Flow | Detail |
|------|--------|
| **A – Zalo → Telegram** | Text + photos → mapped topic. Other media → `[Chưa hỗ trợ]`. Groups use group id. |
| **B – Topic → Zalo** | Admin only. Text, single photo, or album. Target must be receivable (`approved`, not blocked). |
| **C – Channel → Zalo** | Text or photo/album → SQLite job fan-out to allowlist + admin report (`ok`/`fail`). Photos are downloaded **once** then sent to each target. |

---

## Admin commands

Only `TELEGRAM_ADMIN_IDS`, in the **forum** or **private chat with the bot**. Commands are underscore-free (Telegram Markdown won’t break them). `/help` for a cheat sheet.

### Users & groups

| Command | Description |
|---------|-------------|
| `/users` `[page]` `[all\|allowed\|pending\|ids]` | Customers in bridge DB |
| `/user` `[zalo_id]` | Detail (or current topic) |
| `/zalofriends` `[page]` | Friends on personal Zalo (pick ids to add) |
| `/zalochats` `[user\|group]` `[page\|n]` | Recent chats; `group` probes last-message order |
| `/useradd` `<zalo_id>` `[group\|user]` `[name]` | Allowlist + create topic |
| `/useredit` `<zalo_id>` `name=…` `status=…` `kind=group\|user` `muted=0\|1` `blocked=0\|1` | Patch fields |
| `/userdel` `<zalo_id>` | Remove from DB (+ topic best-effort) |
| `/search` `<query>` | Search name / id |
| `/list` | Legacy list alias |

### Moderation

| Command | Description |
|---------|-------------|
| `/approve` `/reject` `[zalo_id]` | In topic or with id |
| `/block` `/unblock` `[zalo_id]` | Hard block |
| `/mute` `/unmute` `[zalo_id]` | Pause / resume broadcast |

### System

| Command | Description |
|---------|-------------|
| `/mode` | Current `ZALO_MODE` |
| `/status` | Counts + forum/channels |
| `/config` `/settings` `/check` | Env (secrets masked) + live admin checks |
| `/recreate` | Recreate deleted forum topic |
| `/retrybroadcast` `<jobId>` | Retry failed broadcast items |

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Watch mode |
| `npm run build` / `npm start` | Production build |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run zalo:login` | Personal QR login |
| `npm run telegram:ids` | Discover user/group/channel ids (**stop bridge first**) |
| `npm run telegram:chat -- <id\|@name>` | Resolve one chat |
| `npm run pm2:start` / `restart` / `logs` / `stop` | PM2 helpers |

Production: **1 PM2 instance, fork mode** (required for personal sessions) — see `ecosystem.config.cjs`.

```bash
npm run build
npm run pm2:start
```

---

## Reliability & ops notes

- Inbound dedup: `(provider, message_id)`
- Broadcast jobs survive restart; limited retries
- Mapping key: `(provider, zalo_user_id)` — switching `personal` ↔ `bot` does not merge customers
- Session / DB / `.env` are gitignored — never commit them
- If channel photo broadcast fails with `Connect Timeout` to `api.telegram.org`, fix network/VPN then `/retrybroadcast <jobId>`

---

## Forking & contributing

1. **Fork** this repository on GitHub.
2. Create a branch: `git checkout -b feature/my-change`
3. Keep secrets out of git (`.env`, `data/zalo-session.json`, `*.db`).
4. Run `npm test` and `npm run typecheck` before opening a PR.
5. Open a Pull Request describing the change and how you tested it.

Please keep the [MIT](./LICENSE) license notice in copies and substantial portions. Attribution in your README (link back to upstream) is appreciated but not required by MIT.

### Third-party / trademarks

- **Telegram** and **Zalo** are trademarks of their respective owners. This project is **not** affiliated with, endorsed by, or supported by Telegram or Zalo.
- Personal mode depends on **zca-js** (MIT / its own license) — unofficial reverse-engineered client; use at your own risk.
- Official Zalo Bot mode uses Zalo’s public Bot API documentation and endpoints.

---

## Disclaimer

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY. Authors are not liable for account bans, message loss, or misuse. Operators must obtain any required consent from end users and follow applicable privacy and messaging regulations.

---

## License

[MIT](./LICENSE) © 2026 tg-zalo contributors
