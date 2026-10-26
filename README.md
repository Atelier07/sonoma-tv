# Sonoma TV — tvOS Minimal Launcher cho LG Smart TV (webOS)

Dự án thay thế launcher mặc định trên Smart TV LG bằng giao diện tối giản phong cách Apple TV (tvOS), tích hợp trình phát nhạc AirPlay hiển thị lời bài hát đồng bộ (Synced Lyrics) và kho video nền 4K Apple Aerial.

---

## Showcase

### 1. Giao diện phát nhạc AirPlay
Bìa album sắc nét, tên bài hát và lời chạy chữ đồng bộ tự động nổi trên nền video 4K:
![AirPlay La La Land](docs/screenshots/lalaland_chorus.jpg)

### 2. Giao diện Launcher chính & Thanh Dock ứng dụng
Thanh Dock kính tối bo cong, chứa các ứng dụng cài trên TV (YouTube, Spotify, Apple Music, Homebrew Channel...):
![Launcher Dock Showcase](docs/screenshots/launcher_showcase.jpg)

---

## ⚡ Các tính năng chính

### 1. Thay thế Launcher gốc & Khởi động tức thì (~0.05s)
- **Neo boot cấp hệ thống (`bootd.json`):** Cấu hình trực tiếp vào `/var/luna/preferences/bootd.json` để hệ thống webOS nhận diện Sonoma TV là ứng dụng khởi động mặc định.
- **Bỏ qua CoverUI:** Khắc phục triệt để lỗi treo màn hình đen hoặc banner chờ 30 giây của LG khi bật TV.
- **Mở máy tức thì:** Khi TV ở chế độ Standby (Quick Start+), bấm Remote là màn hình sáng lên và vào thẳng giao diện trong ~0.05 giây.
- **Bắt phím HOME trên Remote:**
  - Nhấn nhanh: Quay về Sonoma TV launcher.
  - Nhấn giữ 3 giây: Mở lại thanh Ribbon gốc của LG khi cần cài đặt hệ thống.
  - bạn cần kích hoạt tính năng quickstart trên tivi của mình để đạt được tốc độ nhanh nhất

### 2. Tuyển chọn 83 video nền 4K Apple Aerial
- Sử dụng cơ chế giải mã phần cứng **VPU Hole-Punching** của webOS: video chạy trực tiếp trên chip giải mã, không tốn tài nguyên CPU/GPU của giao diện.
- Stream trực tiếp qua mạng LAN, không tốn bộ nhớ flash eMMC của TV.

### 3. Bộ thu AirPlay (Sonoma TV) & Đồng bộ lời bài hát
- Tích hợp trình thu âm thanh AirPlay không nén
- Tự động hiển thị bìa album, tên bài hát và lời bài hát chạy chữ từng câu chuẩn phong cách Apple Music.

### 4. Tinh chỉnh hệ thống & Debloat (10-debloat)
TV LG chạy mượt hơn nhờ dọn dẹp các service chạy ngầm không cần thiết:
- **Tắt AirPlay & HomeKit mặc định của LG:** Ngăn chặn xung đột và hiện tượng trùng lặp 2 luồng AirPlay trên iPhone/Mac.
- **Dừng các service theo dõi & quảng cáo của LG:** `uploadd`, `rdxd`, `admanager`, `contentminer`, `crashreportd`, `webos-preload-manager`...
- **Tối ưu Linux Kernel (`sysctl`):**
  - `vm.swappiness=15`: Giữ RAM vật lý cho app, hạn chế ghi swap ra bộ nhớ flash eMMC giúp tăng tuổi thọ chip nhớ.
  - `net.core.rmem_max=4194304` & buffer UDP: Mở rộng bộ đệm mạng cho video 4K bitrate cao và luồng nhạc AirPlay.

---

## 🛠️ Yêu cầu thiết bị

- Smart TV LG đã Root (có **Homebrew Channel** và SSH Port 22).
- Đã kiểm nghiệm hoàn hảo trên **LG 49SM8100PTA** (webOS 4.5 / Linux 4.4.84 armv7l).

---

## 🚀 Hướng dẫn cài đặt (Deploy)

1. Clone repository về máy tính:
   ```bash
   git clone https://github.com/Atelier07/sonoma-tv.git
   cd sonoma-tv
   ```
2. Mở file `scripts/deploy.sh`, điền địa chỉ IP của TV:
   ```bash
   TV_IP="192.168.1.x"
   ```
3. Chạy lệnh cài đặt 1-click:
   ```bash
   ./scripts/deploy.sh
   ```
Script sẽ tự động đẩy toàn bộ file giao diện, cấu hình khởi động `bootd.json`, bộ thu AirPlay và các daemon tối ưu lên TV.

---

## 🎮 Phím tắt điều khiển Remote

| Phím | Chức năng |
| :--- | :--- |
| **Bất kỳ phím nào** | Đánh thức thanh Dock trượt lên (tự ẩn sau 5 giây không bấm) |
| **D-pad Trái / Phải** | Di chuyển giữa các ứng dụng trên Dock |
| **OK / Enter** | Mở ứng dụng |
| **D-pad Lên** | Ẩn thanh Dock ngay lập tức để ngắm trọn video |
| **HOME (bấm nhanh)** | Quay về màn hình chính Sonoma TV |
| **HOME (giữ 3 giây)** | Mở thanh Home gốc của LG |
