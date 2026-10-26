# DEEPSEEK & AI AGENT ARCHITECTURE GUIDE
> **Tài liệu bàn giao dự án toàn diện cho DeepSeek (hoặc các AI Agent khác)**  
> Dự án: **Apple TV (tvOS) Minimal Launcher on LG Smart TV (webOS 4.5)**

---

## 1. Tóm tắt nhanh bối cảnh dự án (Executive Summary)

- **Mục tiêu:** Xây dựng giao diện TV phong cách Apple TV tvOS tối giản trên Smart TV LG (`192.168.1.6`), có video nền 4K chuyển động mượt mà, đồng hồ/thời tiết cỡ lớn, thanh Dock chứa 10 ứng dụng thật trên TV (bao gồm Homebrew Channel), và khả năng phát nhạc nền kèm lời bài hát đồng bộ chạy theo nhịp (Karaoke Synced Lyrics).
- **Tình trạng hiện tại:**
  - **ĐÃ ROOT THÀNH CÔNG VĨNH VIỄN (`uid=0`, `root`)**.
  - Đã xử lý triệt để lỗi "tắt TV bị mất app" do cơ chế đếm giờ của LG Dev Mode gây ra.
  - Đã chặn vĩnh viễn máy chủ update của LG để không bị thu hồi quyền root.
  - Giao diện đã chạy thực tế trên TV ở độ phân giải 4K 60fps mượt mà.

---

## 2. Thông số kỹ thuật & Cổng kết nối thiết bị

| Thông số | Giá trị |
| :--- | :--- |
| **Model TV** | LG 49SM8100PTA (NanoCell 4K HDR 49") |
| **IP mạng cục bộ** | `192.168.1.6` |
| **webOS Version** | `webOS 4.10.0 (webOS 4.5)` |
| **Kernel Linux** | `4.4.84-p.649.grampians.k5lp.1 armv7l` |
| **Trình duyệt Web** | Chromium 53.0.2785.34 (lõi render giao diện của webOS) |
| **SSH Root (Port 22)** | `ssh -i ~/.ssh/webos_rsa -p 22 -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa root@192.168.1.6` |
| **Telnet Root (Port 23)** | `telnet 192.168.1.6 23` (không mật khẩu, có quyền root tức thì) |
| **Chrome DevTools (Port 9998)** | `http://192.168.1.6:9998/json` (WebSocket CDP để reload, inspect DOM, debug JS, chụp màn hình) |
| **SSAP WebSocket (Port 3000)** | `ws://192.168.1.6:3000` (Client key đã cấp: `"c04dea9b049d0355d69d83478e8e7005"`) |

---

## 3. Kiến trúc Root & Hàng rào bảo vệ (Security & Anti-Wipe)

### 3.1. Lỗ hổng đã dùng để Root:
- Sử dụng công cụ `faultmanager-autoroot` (tác giả *throwaway96*).
- Lợi dụng lỗ hổng phân tích lỗi tiến trình của dịch vụ `faultmanager` chạy quyền root, kích hoạt crash có kiểm soát bằng Python để chạy payload nâng quyền.
- Cài đặt thành công package `org.webosbrew.hbchannel` (Homebrew Channel v0.7.3) và gọi script `elevate-service`.

### 3.2. Cách giải quyết dứt điểm lỗi "Tắt TV bị mất app":
1. **Gỡ bỏ app Developer Mode:** Đã gỡ `com.palmdts.devmode` qua Luna service. Script `start-devmode.sh` (thủ phạm kiểm tra token 50h và kích hoạt `rm -rf /media/developer/apps/*`) đã bị xóa hoàn toàn.
2. **Khóa cờ bất tử:** Gán cờ `chattr +i /var/luna/preferences/devmode_enabled`. Lệnh `rm -rf` không thể xóa được cờ này, webOS luôn hiểu TV ở chế độ cho phép cài đặt app tùy biến.
3. **Chặn Update của LG:** Bổ sung các domain vào `/etc/hosts` trỏ về `127.0.0.1` (`snu.lge.com`, `su.lge.com`, `su-ssl.lge.com`, `lgtvonline.lge.com`, `lgsmartad.com`, `ibis.lgappstv.com`) và kích hoạt cờ `/var/luna/preferences/webosbrew_block_updates`.
4. **Khởi động sớm:** File `/var/lib/webosbrew/startup.sh` được kích hoạt tự động mỗi khi TV khởi động.

---

## 4. Kiến trúc Đồ họa & Ràng buộc Chromium 53

Khi viết thêm CSS/JS cho giao diện này, **DeepSeek BẮT BUỘC phải tuân thủ các quy tắc sau**:

1. **Cô lập Hardware Overlay Plane:**
   - Thẻ `<video>` nằm trong container `.video-stage` có `background: transparent !important; contain: strict; transform: translate3d(0,0,0); backface-visibility: hidden;`.
   - Vùng video này được chip phần cứng VPU "đục lỗ" (hole-punching) hiển thị trực tiếp. Toàn bộ đồ họa HTML/CSS phải có `background: transparent` ở các tầng cha.
2. **CẤM DÙNG `backdrop-filter: blur(...)`:**
   - Chromium 53 không hỗ trợ GPU blur trên webOS. Sử dụng nó sẽ ép GPU Mali phải copy toàn bộ framebuffer và làm mờ bằng phần mềm $\rightarrow$ tụt fps từ 60fps xuống 12fps.
   - Thay thế bằng: Kính tối màu Apple TV (`rgba(18, 20, 28, 0.92)`) kèm viền bán phản chiếu `rgba(255, 255, 255, 0.16)` và đổ bóng sâu.
3. **CẤM DÙNG Flexbox `gap:` và CSS `inset:`:**
   - Chromium 53 (2016) KHÔNG hỗ trợ thuộc tính `gap` trong Flexbox và `inset: 0`.
   - Phải dùng: `top: 0; right: 0; bottom: 0; left: 0;` và margin liền kề `> * + * { margin-left: 16px; }`.
4. **Tránh Layout Thrashing:**
   - Không gọi `getBoundingClientRect()` hoặc đo kích thước DOM khi di chuyển focus D-pad.
   - Vị trí focus và cuộn phải dùng số học thuần túy $O(1)$ (`card.offsetLeft + width / 2`).

---

## 5. Danh sách 10 Ứng dụng thật trên TV

Trích xuất trực tiếp từ `com.webos.applicationManager`:
1. `youtube.leanback.v4`: YouTube
2. `spotify-beehive`: Spotify
3. `com.apple.applemusic`: Apple Music
4. `com.webos.app.browser`: Trình duyệt web
5. `com.instantbits.cast.webvideo`: Web Video Caster
6. `com.webos.app.homeconnect`: Bảng điều khiển nhà
7. `com.webos.app.photovideo`: Ảnh & Video
8. `com.webos.app.music`: Âm nhạc
9. `com.webos.app.discovery`: LG Content Store
10. `org.webosbrew.hbchannel`: Homebrew Channel (Root App Store)

---

## 6. Hướng dẫn phát triển tiếp (Next Steps Roadmap)

### Nhiệm vụ 1: Cài đặt Headless Spotify Connect Daemon (`librespot`)
- **Mục tiêu:** Phát nhạc từ điện thoại qua TV mà không cần mở app Spotify nặng nề của LG.
- **Cách làm:**
  1. Tải binary `librespot` biên dịch sẵn cho `armv7l` (webOS).
  2. Đặt vào `/media/developer/apps/usr/palm/services/` hoặc `/var/lib/webosbrew/init.d/`.
  3. Cấu hình xuất âm thanh qua ALSA/PulseAudio của webOS (`default` hoặc `pulse`).
  4. Bật cờ phát hiện bài hát để đẩy metadata (`track_name`, `artist`, `duration`, `position`) về cho Launcher.

### Nhiệm vụ 2: Màn hình lời bài hát đồng bộ (Karaoke Synced Lyrics)
- **Mục tiêu:** Khi điện thoại phát nhạc, TV hiển thị lời bài hát cuộn mượt mà theo nhịp ca sĩ.
- **Cách làm:**
  1. Lấy tên bài hát và ca sĩ từ Spotify Web API hoặc `librespot`.
  2. Gọi API miễn phí: `https://lrclib.net/api/get?track_name=...&artist_name=...`.
  3. Phân tích chuỗi LRC (có mốc thời gian `[mm:ss.xx]`).
  4. Hiển thị lời trên màn hình:
     - Dòng đang hát: Font 48px, màu trắng sáng, đổ bóng glow.
     - Các dòng xung quanh: Font 32px, độ mờ 40%.
     - Tự động `translateY` cuộn lên êm ái khi thời gian bài hát tăng dần.

---

## 7. Cập nhật ngày 25/10/2026: Trạng thái & Bàn giao xử lý lỗi Boot HDMI 1

Xem chi tiết đầy đủ tại file bàn giao: [`CONTEXT_HANDOVER.md`](file:///Users/macbook/Documents/Projects/webos-tvos-launcher/CONTEXT_HANDOVER.md).

- **Đã hoàn thành:**
  - Fix bug nhảy cóc và lag thanh Dock (gỡ duplicate listener `document.addEventListener('keydown')` và thêm throttle 100ms).
  - Tích hợp AirPlay và Synced Lyrics vào daemon duy nhất `aerial-daemon.js`.
  - Giảm tải hệ thống, dọn sạch telemetry/ads LG, giải phóng 230MB RAM.
- **Tồn đọng cần tiếp tục ngày mai:**
  - Hiện tượng bật nguồn từ Standby vẫn ưu tiên nạp HDMI 1 do `tvpowerd` gọi `launchPhysicalLastInput` khi phát hiện dây cắm cổng HDMI (`bConnected: true` trong EIM).
  - Phương án đã chuẩn bị: Dùng binary wrapper cho `/usr/bin/com.webos.app.inputcommon` (hoặc hoàn thiện bind-mount EIM/tvpowerd) và thêm icon HDMI 1 trên Dock để người dùng vừa dùng được HDMI khi cần, vừa không bị chiếm màn hình lúc bật nguồn.
