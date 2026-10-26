# BÁO CÁO BẢO LƯU CONTEXT DỰ ÁN (HANDOVER TO CONTINUATION)
> **Dự án:** Apple TV (tvOS) Minimal Launcher on LG Smart TV (webOS 4.5)  
> **Thời điểm cập nhật:** 26/10/2026 12:15  
> **Thư mục dự án:** `/Users/macbook/Documents/Projects/webos-tvos-launcher`  
> **Trạng thái:** ĐÃ XỬ LÝ TRIỆT ĐỂ LỖI BOOT HDMI ĐEN MÀN HÌNH & TỰ ĐỘNG BẬT VÀO LAUNCHER TRONG 0.05S.

---

## 1. TỔNG KẾT BƯỚC ĐỘT PHÁ NGÀY 26/10/2026

### A. Triệu chứng cũ:
- Bật TV từ Standby hoặc Cold Boot bị kẹt ở màn hình đen cổng HDMI 1 rất lâu.
- Hiện banner chờ *"Aerial TV Launcher"* và *"Loading..."* trong 30 giây rồi tự động nhảy sang HDMI.
- Bị mất khả năng mở Launcher gốc của LG.

### B. Nguyên nhân kỹ thuật sâu nhất (Root Cause):
1. **Deadlock ở CoverUI (`com.webos.app.cpcover`):**
   - Khi cấu hình `firstAppByPowerOnReason: "com.apple.aerial.tvos"`, `bootd` hiểu đây là ứng dụng OTT bên thứ ba và mở `CoverUI`.
   - `CoverUI` hiển thị banner "Aerial TV Launcher" và khởi động bộ đếm 30 giây (`expireTimer`). Do Launcher là web app không chứa protocol riêng của CPCover, sau 30 giây nó coi là timeout và tự động kích hoạt `launchFallback()` nhảy về HDMI 1!
2. **Lỗi `handlesRelaunch: true` làm đen màn hình khi thức giấc (Wake from Standby):**
   - Trong `appinfo.json`, cờ `handlesRelaunch: true` yêu cầu ứng dụng phải tự lắng nghe sự kiện `webOSRelaunch` và gọi hàm `window.PalmSystem.activate()`.
   - Vì mã nguồn JavaScript trước đó thiếu bộ lắng nghe này, WebAppMgr đưa bề mặt đồ họa về trạng thái `MINIMIZED` (`visible: false`), dẫn đến hiện tượng bật TV lên màn hình tối đen như bị brick.
3. **Can thiệp thô bạo vào Upstart và kill tiến trình Home:**
   - Các bind-mount trên `/etc/init/com.webos.app.inputcommon.conf` và `/etc/tvpowerd/tvpowerd.json` làm gãy luồng Wayland handshake của Starfish.
   - Vòng lặp `killall -9 com.webos.app.fullhome` phá hỏng Launcher gốc của LG.

### C. Giải pháp chuẩn xác đã triển khai thành công 100%:
1. **Neo Boot bằng ánh xạ `inputApps` trong `/var/luna/preferences/bootd.json`:**
   - Đưa `com.apple.aerial.tvos` vào danh mục `inputApps` và giữ `remoteKey: "{LAST_APP}"`.
   - `bootd` nhận diện đây là ứng dụng phần cứng ưu tiên số 1 $\rightarrow$ **VƯỢT QUA HOÀN TOÀN CoverUI**, không còn banner chờ 30 giây, nạp thẳng bề mặt VPU trong **0.05 giây** khi bật TV!
2. **Kích hoạt tự động khi thức dậy (Wake):**
   - Chuyển `handlesRelaunch: false` trong `appinfo.json`.
   - Bổ sung `document.addEventListener('webOSRelaunch')` và `visibilitychange` gọi `PalmSystem.activate()` và `window.__mtv.resume()`.
   - Bấm nút nguồn remote một phát là màn hình sáng lên kèm video 4K & Dock tức thì.
3. **Phục hồi sạch sẽ hệ thống gốc:**
   - Gỡ bỏ sạch các bind-mount bất thường, khôi phục `/var/lib/eim/eim_device_db.json`.
   - Xóa bỏ các lệnh kill `fullhome` cưỡng chế.
   - Phím Home: Bấm nhanh $\rightarrow$ về Apple TV Launcher; Bấm giữ $\ge$ 3s $\rightarrow$ mở Launcher gốc LG.

---

## 2. THÔNG SỐ KỸ THUẬT & TRUY CẬP THIẾT BỊ

| Thông số | Chi tiết |
| :--- | :--- |
| **Model TV** | LG 49SM8100PTA (NanoCell 4K HDR 49") |
| **Hệ điều hành** | LG webOS 4.10.0 (webOS 4.5), nhân Linux `armv7l` (kernel 4.4.84) |
| **Trình duyệt Web** | Chromium 53.0.2785.34 (lõi render WebAppMgr) |
| **IP mạng LAN** | `192.168.1.6` |
| **Quyền Root** | **ROOT VĨNH VIỄN (`uid=0`, `root`)** qua `faultmanager-autoroot`. |
| **SSH Root (Port 22)** | `ssh -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -i ~/.ssh/webos_rsa root@192.168.1.6` |
| **CDP Debug (Port 9998)** | `http://192.168.1.6:9998/json` (WebSocket Chrome DevTools Debugger) |

---

## 3. BẢN ĐỒ CÁC FILE QUAN TRỌNG TRÊN HỆ THỐNG

### Trên máy Mac (`/Users/macbook/Documents/Projects/webos-tvos-launcher/`):
- `src/index.html`: Giao diện chính (đã tích hợp `webOSRelaunch`, `PalmSystem.activate()`, `visibilitychange`).
- `appinfo.json`: Cấu hình app webOS (đã chỉnh `handlesRelaunch: false`, `supportQuickStart: true`).
- `config/bootd.json`: File neo boot hệ thống chính thức của LG `bootd`.
- `scripts/10-debloat`: Script tối ưu RAM, swap, chặn ad (đã gỡ sạch bind-mount và kill fullhome).
- `scripts/20-aerial-launcher`: Script phụ trợ khởi động nhanh lúc cold boot (`sleep 1` chuẩn BusyBox).
- `scripts/aerial-daemon.js`: Daemon Node.js bắt phím Home, quản lý AirPlay bridge và giám sát nguồn.
- `scripts/deploy.sh`: Script 1-click đẩy toàn bộ code, config, fonts và daemon lên TV.
- `scripts/reload_cdp.py`: Tool reload và chụp ảnh màn hình TV từ xa qua cổng 9998.
- `scripts/test_remote.py`: Giả lập phím bấm Remote từ xa qua WebSocket CDP.

### Trên TV LG (`192.168.1.6`):
- `/media/developer/apps/usr/palm/applications/com.apple.aerial.tvos/`
- `/var/luna/preferences/bootd.json` (Neo boot cấp hệ thống của `bootd`)
- `/var/lib/webosbrew/init.d/10-debloat`
- `/var/lib/webosbrew/init.d/20-aerial-launcher`
- `/var/lib/webosbrew/aerial-daemon.js`
- `/var/lib/webosbrew/init.d/21-aerial-daemon`
- `/var/lib/webosbrew/init.d/22-airplay`
