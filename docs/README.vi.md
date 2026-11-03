# tg-zalo (Tiếng Việt)

Bridge **Telegram ↔ Zalo**: mỗi khách một forum topic, reply topic → Zalo, post kênh → broadcast.

- Spec: [../SPEC.md](../SPEC.md)
- Bản tiếng Anh (mặc định GitHub): [../README.md](../README.md)

## Yêu cầu

- Node.js ≥ **22.5** (dùng built-in `node:sqlite`; khuyến nghị 22/24 LTS)
- Telegram bot + **supergroup bật Topics** + **channel** (bot là admin)
- Mode `bot`: Zalo Bot token + HTTPS webhook
- Mode `personal`: nick Zalo phụ + `npm run zalo:login`

## Cài đặt nhanh

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
PORT=3080
```

**Local / dev (mặc định):** long polling `getUpdates` — **không cần** HTTPS public.

```env
# tuỳ chọn; tự = polling khi NODE_ENV != production
ZALO_BOT_TRANSPORT=polling
```

**Production:** bật webhook + HTTPS:

```env
NODE_ENV=production
ZALO_BOT_TRANSPORT=webhook
ZALO_BOT_WEBHOOK_PATH=/webhooks/zalo
```

Nginx → `http://127.0.0.1:3080`, rồi `setWebhook` tới `https://domain/webhooks/zalo`.

Polling và webhook **không dùng song song**; khi start polling sẽ gọi `deleteWebhook` trước.

Khách **phải nhắn bot Zalo trước** mới nhận/gửi được.

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

Dùng **nick phụ**. `zca-js` không chính thức — có rủi ro hạn chế/khóa tài khoản.

## Lệnh admin (Telegram)

Chỉ user trong `TELEGRAM_ADMIN_IDS` (để trống = mọi người, chỉ dùng khi dev):

| Lệnh | Ý nghĩa |
|------|---------|
| `/mode` | Mode Zalo đang chạy |
| `/status` | Số khách / target broadcast |
| `/list` | Danh sách khách |
| `/mute` | Mute broadcast (chạy **trong topic** khách) |
| `/unmute` | Bỏ mute |

## Luồng tin

| Luồng | Hành vi |
|------|---------|
| A | Khách → Zalo → tạo/mở topic Telegram |
| B | Admin reply trong topic → Zalo khách |
| C | Post text lên channel đã cấu hình → fan-out khách active, không muted |

MVP chỉ hỗ trợ **text**.

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
