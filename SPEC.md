# SPEC: Telegram ↔ Zalo Bridge (MVP)

## Product

Bridge Telegram và Zalo:

| Luồng | Mô tả |
|-------|--------|
| A | Khách nhắn Zalo → topic Telegram (mỗi khách 1 topic) |
| B | Admin nhắn trong topic → gửi Zalo đúng khách |
| C | Post kênh Telegram → broadcast tới khách active / không muted |

## Modes

Một codebase, **2 adapter** luôn có trong code. Runtime chỉ bật 1 mode:

- `ZALO_MODE=bot` — Zalo Bot API chính thức
- `ZALO_MODE=personal` — nick Zalo cá nhân (`zca-js`)

## MVP scope

- Text only
- Mapping SQLite bền (`node:sqlite`)
- Anti-loop (bỏ qua tin bot Telegram tự gửi)
- Admin: `/list` `/mute` `/unmute` `/status` `/mode`
- Queue tuần tự + min-interval (personal)

## Out of scope

- 2 mode song song, media, dashboard, multi-nick, CRM

## Stack ghi chú

- DB: Node built-in `node:sqlite` (thay `better-sqlite3` — tránh native build trên một số máy)
- Telegram: grammY polling
- Zalo Bot: `bot-api.zaloplatforms.com` — local `getUpdates` polling; production webhook
- Zalo Personal: `zca-js@2.1.2`

## Nghiệm thu

- [ ] `ZALO_MODE=bot`: A/B/C text OK
- [ ] `ZALO_MODE=personal`: A/B/C text OK (sau QR login)
- [ ] Chỉ 1 adapter start; thiếu credential → fail-fast
- [ ] Mapping sống sau restart; `/mute` chặn broadcast
- [ ] `npm test` + `npm run build` pass
