# Hướng dẫn admin — tg-zalo

Tài liệu ngắn cho người vận hành bot hàng ngày (không cần biết code).

Liên hệ hỗ trợ: Telegram [@mrwin68](https://t.me/mrwin68)

---

## Bot làm gì?

| Việc | Cách làm |
|------|----------|
| Khách nhắn Zalo | Hiện trong **topic** tương ứng trên group forum Telegram |
| Admin trả lời trong topic | Tin (và ảnh) gửi sang đúng người/group Zalo |
| Đăng bài lên **channel** | Tự gửi tới mọi khách/group đã **approved** (không mute/block) |

Mỗi khách Zalo (hoặc mỗi **group** Zalo) = **một topic** trên forum.

---

## Bạn cần nhớ 3 chỗ

1. **Chat riêng với bot** — gõ lệnh quản lý (`/help`, `/users`, `/useradd`…)
2. **Group forum** — đọc/trả lời từng topic khách
3. **Channel** — chỗ đăng tin broadcast

Chỉ tài khoản nằm trong `TELEGRAM_ADMIN_IDS` mới dùng được lệnh và reply sang Zalo.

---

## Việc thường làm

### 1) Thêm người / group Zalo vào hệ thống

**Cách A — khách tự đăng ký (chỉ chat 1-1)**  
Khách nhắn Zalo: `đăng ký` hoặc `/register`  
→ Topic mới hiện `pending`  
→ Vào topic gõ `/approve` hoặc `/reject`

**Cách B — admin thêm tay (khuyên dùng cho group)**

1. Lấy id:
   - `/zalochats` — ai vừa chat gần đây  
   - `/zalochats group` — chỉ group  
   - `/zalofriends` — danh sách bạn bè  
2. Thêm:
   ```
   /useradd 123456789
   /useradd 987654321 group
   ```
   Không cần gõ tên — bot tự lấy từ Zalo nếu được.

### 2) Trả lời khách

Vào đúng topic → gõ chữ hoặc gửi ảnh (có thể gửi nhiều ảnh).

- Chỉ **admin** reply mới sang Zalo  
- Khách phải **approved** và không bị **block**

### 3) Đăng tin hàng loạt (broadcast)

Đăng **text** hoặc **ảnh** lên channel đã cấu hình.  
Bot gửi lần lượt cho danh sách approved → báo cáo admin (`ok` / `fail`).

Gửi lại phần lỗi: `/retrybroadcast <jobId>` (id nằm trong tin báo cáo).

### 4) Tạm dừng / chặn

| Lệnh | Ý nghĩa |
|------|---------|
| `/mute` | Không nhận broadcast (vẫn chat topic ↔ Zalo được) |
| `/unmute` | Bật lại broadcast |
| `/block` | Chặn cứng — không gửi/nhận qua bridge |
| `/unblock` | Bỏ chặn |

Gõ trong topic khách, hoặc kèm id: `/mute 123456789`

---

## Các lệnh hay dùng

Gõ `/help` trên bot để xem bản rút gọn.

### Xem

| Lệnh | Mục đích |
|------|----------|
| `/users` | Ai đã có trong hệ thống |
| `/users pending` | Đang chờ duyệt |
| `/users allowed` | Đã approved |
| `/zalochats` | Chat gần đây trên nick Zalo |
| `/search tên` | Tìm nhanh |
| `/user` hoặc `/user <id>` | Chi tiết 1 khách |
| `/status` | Số liệu nhanh |
| `/config` | Kiểm tra cấu hình + quyền bot |

### Thêm / sửa / xoá

Nhiều id cùng lúc: **cách nhau bởi dấu phẩy** `,`.

| Lệnh | Ví dụ |
|------|--------|
| `/useradd <id>` | `/useradd 123` |
| `/useradd <id> group` | `/useradd 456 group` |
| `/useradd id1,id2,id3` | `/useradd 111,222,333` |
| `/useradd id1,id2 group` | Thêm nhiều group |
| `/useradd id1,id2 readonly` | Chỉ Zalo→Telegram (không reply ngược) |
| `/useredit <id> name=Tên` | Đổi tên topic/hiển thị |
| `/useredit id1,id2 inbound_only=1` | Bật chỉ đọc hàng loạt |
| `/userdel <id>` | Xoá khỏi hệ thống |
| `/userdel id1,id2,id3` | Xoá hàng loạt |

### Duyệt

Trong topic: `/approve` · `/reject` · `/block` · `/unblock` · `/mute` · `/unmute` · `/readonly` · `/twoway`

### Sự cố

| Lệnh | Khi nào |
|------|---------|
| `/recreate` | Topic bị xoá trên Telegram — tạo lại |
| `/retrybroadcast 12` | Broadcast lỗi, gửi lại |
| `/config` | Bot không gửi được / nghi sai quyền |

---

## Trạng thái khách

| Status | Ý nghĩa |
|--------|---------|
| `pending` | Chờ admin duyệt |
| `approved` | Đang dùng bình thường + nhận broadcast |
| `rejected` | Từ chối đăng ký |
| `unsubscribed` | Khách tự hủy (`hủy đăng ký`) |

---

## Lưu ý nhanh

- **Group Zalo** gắn theo **id group**, không theo từng thành viên gửi tin. Topic hiện `Tên người gửi: nội dung`.
- Người lạ nhắn Zalo mà chưa đăng ký / chưa `/useradd` → bot **không** tự trả lời, **không** tạo topic.
- `/mute` ≠ hủy đăng ký của khách.
- `/readonly` (hoặc `ro` / `1way`): topic chỉ nhận tin Zalo→Telegram; reply trong topic **không** sang Zalo. Bật lại bằng `/twoway`.
- Ảnh channel/topic đều hỗ trợ; nếu broadcast ảnh lỗi timeout Telegram → kiểm tra mạng rồi `/retrybroadcast`.
- Forum: bot phải là **admin** (+ Manage Topics). Channel: bot phải là admin. Kiểm bằng `/config`.

---

## Checklist ngày đầu

1. [ ] Bạn nằm trong `TELEGRAM_ADMIN_IDS`
2. [ ] Bot admin đúng forum (có Topics) và channel
3. [ ] `/config` không báo đỏ forum/channel
4. [ ] `/zalochats` xem được id → `/useradd` thử 1 người
5. [ ] Reply trong topic → Zalo nhận được
6. [ ] Post thử channel → khách approved nhận được

---

## Cần hỗ trợ?

Telegram: [@mrwin68](https://t.me/mrwin68)
