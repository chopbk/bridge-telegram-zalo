# tg-zalo

Bridge **Telegram ↔ Zalo**: mỗi khách một forum topic, reply topic → Zalo, post kênh → broadcast.

Xem [SPEC.md](./SPEC.md).

## Yêu cầu

- Node.js ≥ **22.5** (dùng built-in `node:sqlite`; khuyến nghị 22/24 LTS)
- Telegram bot + **supergroup bật Topics** + **channel** (bot là admin)
- Mode `bot`: Zalo Bot token + HTTPS webhook
- Mode `personal`: nick Zalo phụ + `npm run zalo:login`

## Cài đặt

```bash
cp .env.example .env
# điền TELEGRAM_* và credential theo mode
npm install
npm run dev
```

### Mode Zalo Bot

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=...
ZALO_BOT_WEBHOOK_PATH=/webhooks/zalo
PORT=3080
```

Nginx trỏ HTTPS → `http://127.0.0.1:3080`, đăng ký webhook Zalo tới `https://domain/webhooks/zalo`.

### Mode Zalo cá nhân

```env
ZALO_MODE=personal
ZALO_SESSION_PATH=./data/zalo-session.json
ZALO_MIN_SEND_INTERVAL_MS=1500
```

```bash
npm run zalo:login   # quét QR → lưu session
npm run dev
```

## Lệnh admin (Telegram)

Chỉ user trong `TELEGRAM_ADMIN_IDS` (để trống = mọi người, chỉ dùng khi dev):

| Lệnh | Ý nghĩa |
|------|---------|
| `/mode` | Mode Zalo đang chạy |
| `/status` | Số khách / target broadcast |
| `/list` | Danh sách khách |
| `/mute` | Mute broadcast (chạy **trong topic** khách) |
| `/unmute` | Bỏ mute |

## Production

```bash
npm run build
npm run pm2:start
```

`ecosystem.config.cjs`: **1 instance, fork** (bắt buộc với personal session).

## Scripts

| Script | Mô tả |
|--------|--------|
| `npm run dev` | Dev watch |
| `npm run build` / `start` | Build & chạy `dist/` |
| `npm test` | Vitest |
| `npm run zalo:login` | QR login personal |
