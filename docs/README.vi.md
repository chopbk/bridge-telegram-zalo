# tg-zalo (Tiếng Việt)

Bridge **Telegram ↔ Zalo** cho hỗ trợ khách và broadcast kênh.

| Hướng | Việc xảy ra |
|-------|-------------|
| **A** | Zalo (1-1 hoặc group) → một **forum topic** Telegram / mỗi id đã map |
| **B** | Admin reply trong topic → đúng user/group Zalo (text + ảnh) |
| **C** | Post **channel** Telegram (text/ảnh) → fan-out tới danh sách Zalo đã duyệt |

- Spec: [../SPEC.md](../SPEC.md)
- English (mặc định GitHub): [../README.md](../README.md)
- **Hướng dẫn admin:** [ADMIN.vi.md](./ADMIN.vi.md) ← bắt đầu từ đây nếu bạn vận hành bot
- Giấy phép: [MIT](../LICENSE)
- Liên hệ: Telegram [@mrwin68](https://t.me/mrwin68)

> **Cảnh báo:** Mode personal dùng automation Zalo không chính thức ([zca-js](https://github.com/RFS-ADRENO/zca-js)). Có rủi ro hạn chế/khóa nick. Nên dùng **nick phụ**. Bạn tự chịu trách nhiệm tuân thủ điều khoản Telegram/Zalo và pháp luật.

---

## Tính năng

- **2 mode Zalo** (chạy một lúc một): `personal` (zca-js, MVP khuyến nghị) hoặc `bot` API chính thức
- **Hộp thư forum**: mỗi topic gắn 1 user **hoặc group** (`thread_kind`)
- **Đăng ký**: khách `đăng ký` → `pending` → admin `/approve` / `/reject`
- **CRUD allowlist**: `/useradd`, `/useredit`, `/userdel`, `/users`, `/search`
- **Group**: map theo **id group**, không theo thành viên gửi; `/useradd <id> group`
- **Ảnh 2 chiều**: topic ↔ Zalo (1 ảnh / album); ảnh channel cũng broadcast
- **Nhiều admin / nhiều channel**: `TELEGRAM_ADMIN_IDS`, `TELEGRAM_CHANNEL_ID` (phẩy)
- **Job broadcast** SQLite + retry + báo cáo admin; `/retrybroadcast`
- **Rate limit** gửi personal
- **Helper**: `telegram:ids` lấy id chat; `/config` kiểm tra quyền bot

---

## Yêu cầu

- **Node.js ≥ 18** (`better-sqlite3`; khuyến nghị 20/22 LTS)
- Bot Telegram (BotFather)
- **Supergroup bật Topics**; bot **admin** (có Manage Topics)
- Một hoặc nhiều **channel**; bot admin
- Mạng vào được `api.telegram.org` (nhiều ISP VN timeout — cân nhắc VPN/VPS)
- Mode personal: nick Zalo phụ + đăng nhập QR
- Mode bot: token Zalo Bot (+ secret webhook production)

---

## Cài đặt nhanh

```bash
git clone https://github.com/<your-org>/tg-zalo.git
cd tg-zalo
cp .env.example .env
npm install

# 1) Điền TELEGRAM_BOT_TOKEN
# 2) Lấy id (tắt bridge nếu đang chạy — cùng token không poll 2 lần)
npm run telegram:ids
# Chat riêng với bot → user id (ADMIN_IDS)
# Thêm bot vào forum / channel, gõ /id → FORUM / CHANNEL ids

# 3) Điền đủ .env rồi:
npm run zalo:login   # chỉ personal — quét QR
npm run dev
```

Kiểm tra: chat riêng với bot, admin gõ `/config`.

---

## Biến môi trường

Xem [`.env.example`](../.env.example).

| Biến | Ý nghĩa |
|------|---------|
| `ZALO_MODE` | `personal` \| `bot` |
| `TELEGRAM_BOT_TOKEN` | Token bot |
| `TELEGRAM_FORUM_GROUP_ID` | Id forum (thường `-100…`) |
| `TELEGRAM_CHANNEL_ID` | Một hoặc nhiều channel, phẩy |
| `TELEGRAM_ADMIN_IDS` | Một hoặc nhiều **user id** admin, phẩy (**bắt buộc**) |
| `ZALO_SESSION_PATH` | File session personal (đã gitignore) |
| `ZALO_MIN_SEND_INTERVAL_MS` | Delay giữa các lần gửi (mặc định `1500`) |
| `ZALO_SEND_MAX_PER_MINUTE` | Trần gửi/phút (mặc định `20`) |
| `ZALO_BOT_TOKEN` | Bắt buộc nếu `bot` |
| `ZALO_BOT_TRANSPORT` | `polling` \| `webhook` |
| `ZALO_BOT_WEBHOOK_SECRET` | Bắt buộc webhook |
| `DATABASE_PATH` | SQLite |
| `JOB_MAX_RETRIES` | Số lần retry broadcast item |
| `LIST_PAGE_SIZE` | Phân trang lệnh list |

```env
ZALO_MODE=personal
TELEGRAM_BOT_TOKEN=123456:ABC…
TELEGRAM_FORUM_GROUP_ID=-1001234567890
TELEGRAM_CHANNEL_ID=-1001111111111,-1002222222222
TELEGRAM_ADMIN_IDS=111111111,222222222
ZALO_SESSION_PATH=./data/zalo-session.json
```

---

## Checklist Telegram

1. Tạo bot [@BotFather](https://t.me/BotFather).
2. Tạo **supergroup**, bật **Topics**, thêm bot admin (Manage Topics, gửi tin…).
3. Tạo channel, thêm bot admin.
4. `npm run telegram:ids` → điền `.env`.
5. Chạy bridge; `/config` — forum/channel phải thấy bot là administrator.

---

## Mode Zalo

### Personal (MVP khuyến nghị)

```bash
npm run zalo:login
npm run dev
```

- Dùng [zca-js](https://github.com/RFS-ADRENO/zca-js) (không chính thức).
- Listener phải chạy để nhận tin + gửi ảnh ổn định.
- Chỉ **một** phiên web / nick — đừng mở Zalo Web song song.

### Bot API chính thức

```env
ZALO_MODE=bot
ZALO_BOT_TOKEN=…
```

Khách phải nhắn bot Zalo trước mới nhận được tin. Gửi ảnh mode bot chưa đầy đủ — dùng personal nếu cần bridge ảnh.

---

## Vòng đời khách & group

### User 1-1

1. Khách nhắn: `đăng ký` / `/register` / `/start`
2. Tạo topic `pending`
3. Admin `/approve` hoặc `/reject`
4. Chỉ **approved**, không muted/blocked → nhận broadcast kênh
5. Hủy: `hủy đăng ký` / `/stop`
6. Người lạ 1-1: bỏ qua im lặng (không auto-reply, không tạo topic) — trừ khi họ `/register` hoặc admin `/useradd`

### Group

- Map theo **id group**
- Thêm: `/useradd <group_id> group [tên]`
- Topic hiển thị: `Tên người gửi: nội dung`
- **Không** auto-reply đăng ký/hủy trong group
- Group chưa add → bỏ qua im lặng

`/mute` chỉ tắt broadcast, khác hủy đăng ký của khách.

---

## Luồng tin

| Luồng | Chi tiết |
|------|----------|
| **A** | Zalo → topic: text (giữ đậm/nghiêng/gạch chân/gạch ngang) + ảnh + link preview (kể cả tin của mình, prefix `Bạn:`); media khác → `[Chưa hỗ trợ]`; group theo group id |
| **B** | Topic → Zalo: admin; text / 1 ảnh / album; khách phải receivable |
| **C** | Channel text/ảnh → job fan-out + báo cáo admin; ảnh tải **1 lần** rồi gửi lần lượt |

---

## Lệnh admin

Chỉ `TELEGRAM_ADMIN_IDS`, trong **forum** hoặc **chat riêng với bot**. Lệnh viết liền (không `_`). `/help` để xem nhanh.

### User & group

| Lệnh | Ý nghĩa |
|------|---------|
| `/users` `[page]` `[all\|allowed\|pending\|ids]` | Khách trong DB |
| `/user` `[zalo_id]` | Chi tiết |
| `/zalofriends` | Bạn bè nick Zalo (personal) |
| `/zalochats` `[user\|group]` `[n]` | Chat gần đây **full** (tách tin); `group` probe tin cuối |
| `/useradd` `<id>` `[group\|user]` `[tên]` | Thêm + tạo topic |
| `/useredit` … | Sửa field |
| `/userdel` `<id>` | Xoá |
| `/search` `<query>` | Tìm |

### Duyệt / chặn

| Lệnh | Ý nghĩa |
|------|---------|
| `/approve` `/reject` `[zalo_id]` | Duyệt / từ chối |
| `/block` `/unblock` | Chặn cứng |
| `/mute` `/unmute` | Tắt/bật broadcast |
| `/readonly` `/twoway` | Chỉ Zalo→TG / bật lại 2 chiều |
| `/signature` | Chữ ký broadcast channel→Zalo |
| `/del` (reply) | Xoá/thu hồi tin 2 phía |

### Hệ thống

| Lệnh | Ý nghĩa |
|------|---------|
| `/mode` `/status` | Mode / thống kê |
| `/config` | Cấu hình + check quyền live |
| `/recreate` | Tạo lại topic |
| `/retrybroadcast` `<jobId>` | Retry broadcast |

---

## Scripts

| Script | Mô tả |
|--------|--------|
| `npm run dev` | Dev watch |
| `npm run build` / `start` | Build & chạy |
| `npm test` / `typecheck` | Test / typecheck |
| `npm run zalo:login` | QR personal |
| `npm run telegram:ids` | Lấy id (**tắt bridge trước**) |
| `npm run telegram:chat -- <id\|@name>` | Tra 1 chat |
| `npm run pm2:*` | PM2 |

Production: **1 instance, fork** — `ecosystem.config.cjs`.

```bash
npm run build && npm run pm2:start
```

---

## Fork & đóng góp

1. **Fork** repo trên GitHub.
2. Nhánh mới: `git checkout -b feature/my-change`
3. Không commit secret (`.env`, `data/zalo-session.json`, `*.db`).
4. Chạy `npm test` và `npm run typecheck`.
5. Mở Pull Request mô tả thay đổi + cách test.

Giữ thông báo giấy phép [MIT](../LICENSE) trong bản sao. Ghi nguồn upstream trong README của bạn là được khuyến khích.

### Bên thứ ba / thương hiệu

- **Telegram** và **Zalo** thuộc chủ sở hữu tương ứng. Dự án **không** liên kết / được bảo trợ bởi Telegram hay Zalo.
- Mode personal phụ thuộc **zca-js** — client không chính thức, tự chịu rủi ro.
- Mode bot dùng Bot API công khai của Zalo.

---

## Liên hệ

- Telegram: [@mrwin68](https://t.me/mrwin68)

## Miễn trừ trách nhiệm

Phần mềm cung cấp “NGUYÊN TRẠNG”, không bảo đảm. Tác giả không chịu trách nhiệm khóa tài khoản, mất tin, hoặc sử dụng sai mục đích. Người vận hành phải xin consent người dùng cuối khi luật yêu cầu.

---

## Giấy phép

[MIT](../LICENSE) © 2026 tg-zalo contributors
