# SPEC: Telegram ↔ Zalo Bridge (MVP)

## Product

Bridge Telegram và Zalo:

| Luồng | Mô tả |
|-------|--------|
| A | Khách `/register` hoặc "đăng ký" → tạo topic `pending` → admin duyệt; tin thường không tự tạo topic. Admin `/useradd` cũng tạo topic |
| B | Admin nhắn trong topic → gửi Zalo đúng khách (chỉ khi `approved` và không `blocked`) |
| C | Post kênh Telegram → broadcast tới khách `approved`, không muted, không blocked |

## Modes

Một codebase, **2 adapter** luôn có trong code. Runtime chỉ bật 1 mode:

- `ZALO_MODE=personal` — **MVP dùng thật trước** (`zca-js`), rate limit + min-interval
- `ZALO_MODE=bot` — Zalo Bot API chính thức (giữ adapter; webhook secret + persist trước 200)

## MVP scope

- Text + ảnh 2 chiều (1 ảnh / album nhiều ảnh); file/voice/khác → báo topic (`[Chưa hỗ trợ]`)
- Mapping SQLite bền (`better-sqlite3`), keyed theo `(provider, zalo_user_id)`
- Đăng ký: `pending` / `approved` / `rejected` / `unsubscribed`; mute admin ≠ hủy đăng ký
- Anti-loop (bỏ qua tin bot Telegram tự gửi)
- Admin bắt buộc (`TELEGRAM_ADMIN_IDS`); lệnh chỉ trong forum group; reply topic chỉ admin
- Quản lý user: `/users`, `/useradd`, `/useredit`, `/userdel` (+ approve/reject theo zalo id); lệnh không dùng `_`
- Queue tuần tự + `ZALO_MIN_SEND_INTERVAL_MS` + `ZALO_SEND_MAX_PER_MINUTE`
- Jobs broadcast + retry + dedup `processed_messages`; báo cáo admin sau broadcast

## Out of scope

- 2 mode song song, video/file/voice 2 chiều, dashboard, multi-nick, CRM

## Stack ghi chú

- DB: `better-sqlite3`
- Telegram: grammY polling
- Zalo Bot: `bot-api.zaloplatforms.com` — local `getUpdates`; production webhook + secret
- Zalo Personal: `zca-js@2.1.2`

## Nghiệm thu

- [x] `ZALO_MODE=personal`: luồng A/B/C text + ảnh (sau QR login; kiểm chứng tay với ≥2 khách)
- [ ] `ZALO_MODE=bot`: A/B/C text OK (adapter sẵn; chưa là gate MVP)
- [x] Chỉ 1 adapter start; thiếu credential / admin IDs → fail-fast
- [x] Mapping sống sau restart; scoped theo provider
- [x] Khách chưa `approved` không nhận broadcast
- [x] Hủy đăng ký có hiệu lực ngay (không còn target broadcast)
- [x] User ngoài admin IDs không điều khiển / không forward sang Zalo
- [x] Restart không mất job `pending`/`failed` còn retry
- [x] Dedup theo message ID (không xử lý trùng)
- [x] Mute admin tách khỏi unsubscribe
- [x] `npm test` + `npm run build` pass
