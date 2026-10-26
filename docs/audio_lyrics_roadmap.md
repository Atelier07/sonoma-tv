# Kế hoạch Kỹ thuật: Headless Spotify Connect (`librespot`) & Lời bài hát Karaoke (`Synced Lyrics`)

Tài liệu này định hình lộ trình kỹ thuật cho lập trình viên (hoặc AI tiếp nhận như DeepSeek) để xây dựng 2 tính năng âm nhạc trên chiếc TV LG đã root.

---

## 1. Tính năng 1: Headless Spotify Connect Daemon (`librespot`)

### 1.1. Nguyên lý hoạt động
- Ứng dụng Spotify chính thức của LG là một ứng dụng Web Chromium rất nặng (ngốn 250MB-350MB RAM).
- Thay vào đó, ta sử dụng **`librespot`** (bộ thư viện mã nguồn mở viết bằng Rust chuyên giải mã giao thức Spotify Connect).
- `librespot` chạy dưới dạng tiến trình nền không giao diện (headless daemon), chỉ tiêu tốn:
  - **RAM:** ~15MB.
  - **CPU:** < 3%.
  - **Đầu ra âm thanh:** Xuất trực tiếp qua hệ thống ALSA hoặc PulseAudio của TV webOS.

### 1.2. Các bước triển khai
1. **Biên dịch hoặc tải binary cho kiến trúc `armv7l`:**
   - Dùng binary `librespot` tương thích kiến trúc ARMv7 (hard-float) của webOS.
   - Hoặc dùng phiên bản đã được cộng đồng `webosbrew` đóng gói.
2. **Cấu hình daemon khởi động cùng TV:**
   - Đặt file thực thi vào: `/var/lib/webosbrew/bin/librespot`.
   - Tạo script khởi chạy tại `/var/lib/webosbrew/init.d/90-librespot.sh`:
     ```sh
     #!/bin/sh
     /var/lib/webosbrew/bin/librespot \
       --name "LG NanoCell TV" \
       --backend alsa \
       --device default \
       --bitrate 320 \
       --initial-volume 75 \
       --onevent /var/lib/webosbrew/scripts/spotify_event.sh &
     ```
3. **Bắt sự kiện bài hát (`--onevent`):**
   - Khi điện thoại chuyển bài, `librespot` gọi script `spotify_event.sh` với các biến môi trường:
     - `TRACK_ID`, `TRACK_NAME`, `ARTIST_NAME`, `ALBUM_NAME`, `DURATION_MS`, `POSITION_MS`.
   - Script này lưu thông tin vào file JSON `/tmp/spotify_current.json` hoặc đẩy qua WebSocket về Launcher.

---

## 2. Tính năng 2: Màn hình lời bài hát đồng bộ (Karaoke Synced Lyrics)

### 2.1. Nguồn dữ liệu lời bài hát
Sử dụng **LRCLIB API** (`https://lrclib.net`) - kho dữ liệu lời bài hát mở miễn phí lớn nhất hiện nay:
- **Endpoint:**
  ```http
  GET https://lrclib.net/api/get?track_name={TÊN_BÀI}&artist_name={CA_SĨ}
  ```
- **Dữ liệu trả về:** Chuỗi LRC đồng bộ thời gian thực đến từng phần trăm giây (`syncedLyrics`):
  ```text
  [00:12.45] Chẳng biết từ bao giờ
  [00:15.10] Ta đã dần xa nhau
  [00:18.80] Giọt nước mắt rơi trên hàng mi
  ```

### 2.2. Xử lý hiển thị trên giao diện Launcher (HTML/CSS)
1. **Bộ phân tích cú pháp LRC (LRC Parser):**
   - Chuyển đổi định dạng `[mm:ss.xx] Text` thành danh sách các đối tượng:
     ```js
     { time: 12.45, text: "Chẳng biết từ bao giờ" }
     ```
2. **Đồng bộ với thời gian phát nhạc:**
   - Nếu dùng Spotify Web API: Thăm dò vị trí mili-giây (`progress_ms`) mỗi 500ms.
   - Nếu dùng `librespot`: Tính toán thời gian tăng dần nội suy bằng `performance.now()`.
3. **Hiệu ứng Typography cao cấp (Phong cách Apple Music Sing):**
   - **Dòng đang hát:**
     - Phóng to nhẹ (`transform: scale(1.08)`).
     - Màu trắng sáng (`#ffffff`) với độ mờ text-shadow màu theo bìa album (`text-shadow: 0 0 20px rgba(accent, 0.6)`).
     - Độ mờ `opacity: 1`.
   - **Các dòng xung quanh:**
     - Font nhỏ hơn, màu xám khói (`rgba(255, 255, 255, 0.45)`).
     - Độ mờ `opacity: 0.4`.
   - **Hiệu ứng cuộn:**
     - Sử dụng `transform: translate3d(0, -Ypx, 0)` với transition mượt mà 0.4s để đưa dòng đang hát vào đúng vị trí 1/3 phía trên màn hình TV.
   - **Nền video 4K:**
     - Video Dubai 4K phía sau tự động làm tối nhẹ (`opacity: 0.7`) để lời bài hát nổi bật rực rỡ.
