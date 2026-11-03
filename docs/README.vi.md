# tg-zalo (Tiếng Việt)

Bridge **Telegram ↔ Zalo**: mỗi khách một forum topic, reply topic → Zalo, post kênh → broadcast.

- Spec: [../SPEC.md](../SPEC.md)
- Bản tiếng Anh (mặc định GitHub): [../README.md](../README.md)

## Yêu cầu

- Node.js ≥ **22.5** (dùng built-in `node:sqlite`; khuyến nghị 22/24 LTS)
- Telegram bot + **supergroup bật Topics** + **channel** (bot là admin)
- **`TELEGRAM_ADMIN_IDS` bắt buộc** (không để trống)
- Mode `personal` (**MVP khuyến nghị**): nick Zalo phụ + `npm run zalo:login`
- Mode `bot`: Zalo Bot token; production webhook cần secret

## Cài đặt nhanh

```bash
cp .env.example .env
# điền TELEGRAM_* (kèm ADMIN_IDS) và credential theo mode
npm install
npm run zalo:login   # nếu personal
npm run dev
```

### Mode Zalo cá nhân (MVP trước)

```env
ZALO_MODE=personal
ZALO_SESSION_PATH=./data/zalo-session.json
ZALO_MIN_SEND_INTERVAL_MS=1500
ZALO_SEND_MAX_PER_MINUTE=20
TELEGRAM_ADMIN_IDS=123456789
```

```bash
npm run zalo:login   # quét QR → lưu session
npm run dev
```

Dùng **nick phụ**. `zca-js` không chính thức — có rủi ro hạn chế/khóa tài khoản. Rate limit + delay giúp giảm rủi ro khi broadcast.

### Mode Zalo Bot

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=...
PORT=3080
```

**Local / dev (mặc định):** long polling `getUpdates`.

**Production:** webhook + HTTPS + `ZALO_BOT_WEBHOOK_SECRET` (header `X-Zalo-Bot-Api-Secret-Token`).

Khách **phải nhắn bot Zalo trước** mới nhận/gửi được.

## Đăng ký khách

Topic **không** tự tạo khi khách nhắn lung tung. Chỉ tạo khi:

1. Khách nhắn Zalo: `đăng ký` / `dang ky` / `/register` (hoặc `/start`) → topic **pending**
2. Hoặc admin `/useradd <zalo_id>` → topic **approved**

Sau đó:
3. Admin trong topic: `/approve` hoặc `/reject`
4. Chỉ khách **approved**, không muted, không blocked mới nhận broadcast
5. Khách hủy: `hủy đăng ký` / `/stop` → `unsubscribed`

Tin thường từ người chưa có trong danh sách → bot Zalo gợi ý đăng ký, **không** mở topic.

**Mute** (`/mute`) chỉ tạm tắt broadcast — khác hủy đăng ký của khách.

## Lệnh admin (Telegram)

Chỉ user thuộc `TELEGRAM_ADMIN_IDS`, trong **forum group** hoặc **chat riêng với bot**. Gõ `/help` để xem nhanh.

Lệnh viết liền (không dấu `_`) để tránh Markdown Telegram làm hỏng tin.

### Danh sách & CRUD người dùng Zalo

| Lệnh | Ý nghĩa |
|------|---------|
| `/users` | Khách đã ghi nhận trong bridge DB (có `zalo=…`) |
| `/users allowed` | Chỉ danh sách cho phép (approved) |
| `/users pending` | Chờ duyệt |
| `/users ids` | Chỉ in các Zalo ID (dễ copy) |
| `/users 2` | Trang 2 |
| `/zalofriends` | Bạn bè trên nick Zalo (personal) — lấy id rồi `/useradd` |
| `/zalochats` | Chat gần đây (user + group); lọc `/zalochats group` |
| `/user <zalo_id>` | Chi tiết 1 khách (hoặc `/user` trong topic) |
| `/useradd <zalo_id> [group\|user] [tên]` | Thêm allowlist; group gửi bằng ThreadType.Group |
| `/useredit <zalo_id> name=Tên kind=group status=approved` | Sửa (kind=user\|group) |
| `/userdel <zalo_id>` | Xoá khỏi DB (+ xoá topic nếu được) |
| `/search <query>` | Tìm theo tên / zalo id |
| `/list [page] [status]` | Alias list cũ |

### Duyệt / chặn

| Lệnh | Ý nghĩa |
|------|---------|
| `/approve` `/reject` `[zalo_id]` | Duyệt / từ chối (trong topic **hoặc** kèm id) |
| `/block` `/unblock` `[zalo_id]` | Chặn cứng |
| `/mute` `/unmute` `[zalo_id]` | Tạm tắt/bật broadcast |

### Hệ thống

| Lệnh | Ý nghĩa |
|------|---------|
| `/mode` `/status` | Mode / thống kê |
| `/recreate` | Tạo lại topic nếu bị xóa |
| `/retrybroadcast <jobId>` | Gửi lại các item fail của broadcast |

Reply text trong topic khách → Zalo **chỉ khi** người gửi là admin và khách `approved`.

## Luồng tin

| Luồng | Hành vi |
|------|---------|
| A | Khách → Zalo → topic; đăng ký/hủy; media chưa hỗ trợ → báo topic |
| B | Admin reply trong topic → Zalo khách (nếu approved) |
| C | Post text kênh → job SQLite fan-out + báo cáo admin (ok/fail) |

MVP chỉ **gửi** text; nhận media thì thông báo trên Telegram.

## Độ tin cậy

- Dedup inbound theo `(provider, message_id)`
- Broadcast lưu job SQLite, retry có giới hạn, resume sau restart
- Mapping theo `(provider, zalo_user_id)` — đổi mode không lẫn khách

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
