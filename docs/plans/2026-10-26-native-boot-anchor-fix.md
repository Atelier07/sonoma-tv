# Kế hoạch Tổng thể: Neo Boot Trực tiếp Apple TV Launcher & Phục hồi Launcher Gốc trên webOS 4.5

> **Mục tiêu:** 
> 1. Xử lý triệt để hiện tượng bật TV bị màn hình đen HDMI lâu.
> 2. Neo (anchor) launcher tùy biến `com.apple.aerial.tvos` thành Boot App mặc định ở tầng gốc hệ thống (`bootd`), bật TV là vào thẳng Launcher ngay lập tức.
> 3. Phục hồi hoàn toàn khả năng mở Launcher gốc của LG (`com.webos.app.home` / `com.webos.app.fullhome`) mà không bị xung đột hay tự động đóng.
> 4. Bổ sung icon HDMI 1 lên thanh Dock để người dùng chủ động chuyển sang thiết bị ngoại vi khi cần.

---

## 1. BÁO CÁO CHẨN ĐOÁN KỸ THUẬT SÂU (ROOT CAUSE REPORT)

Sau khi truy cập trực tiếp qua SSH Root trên TV LG (`192.168.1.6`) và trích xuất nhật ký thực thi từ `bootd` (`/var/log/bootd.log`), `sam`, `lsm` và `tvpowerd`, chúng tôi xác định chính xác các nguyên nhân gây ra tình trạng hiện tại:

### A. Vì sao bật TV bị màn hình đen HDMI 1 rất lâu?
1. **Dây HDMI vật lý đang cắm:** TV nhận diện cổng HDMI 1 đang có thiết bị/cáp kết nối (`bConnected: true`).
2. **Cơ chế khởi động của `bootd` (Boot Manager):**
   - Khi TV thức dậy từ Standby (Quick Start+ / Suspend-to-RAM), tiến trình `/usr/sbin/bootd` đọc file `/etc/palm/bootd.json`:
     ```json
     "firstAppByPowerOnReason": {
         "remoteKey": "{LAST_APP}",
         "localKey": "{LAST_APP}"
     }
     ```
   - Giá trị `{LAST_APP}` kích hoạt `bootd` gọi sang `com.webos.service.utp.externaldevice/getLastInput`. Dịch vụ này trả về `deviceID: "HDMI_1"`.
   - `bootd` tra cứu bảng `inputApps` và tự động phát lệnh Luna:
     `luna://com.webos.applicationManager/launch {"id": "com.webos.app.hdmi1", "noSplash": true, "params": {"boot": true}}`
   - Dẫn đến việc `com.webos.app.hdmi1` được cấp quyền Card Surface toàn màn hình ngay từ giây đầu tiên.
3. **Sự can thiệp bind-mount làm gãy luồng khởi tạo Wayland của `inputcommon`:**
   - Phiên trước đã bind-mount file `/var/lib/webosbrew/com.webos.app.inputcommon.conf` đè lên `/etc/init/com.webos.app.inputcommon.conf`, đồng thời sửa `tvpowerd.json`.
   - File conf gốc của `inputcommon` chứa các tín hiệu Upstart quan trọng (`emits snapshot-component-ready SNAPSHOT_COMPONENT=tvwin`). Khi bị can thiệp sai cách, binary native `/usr/bin/com.webos.app.inputcommon` bị treo ở trạng thái chờ khởi tạo framebuffer, khiến TV hiển thị màn hình đen vô tận và không nhả bề mặt đồ họa (LSM Surface) cho app khác.

### B. Vì sao không tự động boot vào Aerial Launcher?
1. **Lỗi cú pháp BusyBox trong `20-aerial-launcher`:**
   - Trong script khởi động `/var/lib/webosbrew/init.d/20-aerial-launcher`, lệnh `sleep 0.4` bị BusyBox từ chối (`sleep: invalid number '0.4'`).
   - Hậu quả: Vòng lặp bắn dồn dập hàng trăm lệnh `luna-send` trong vòng 1-2 giây làm nghẽn bus hệ thống và thoát sớm trước khi TV sẵn sàng.
2. **`init.d` không chạy khi bật từ Standby:**
   - Các script trong `/var/lib/webosbrew/init.d/` chỉ chạy khi **Cold Boot** (khởi động nguồn từ đầu). Khi người dùng tắt/bật TV bằng remote, TV ở chế độ Standby (Quick Start+), `init.d` không được kích hoạt lại.
3. **`aerial-daemon.js` bị nghẽn buffer:**
   - Tiến trình daemon Node 0.12 lắng nghe sự kiện qua `luna-send -i`. Do kết nối qua Linux pipe (không phải TTY), `stdout` bị block-buffer 4096 bytes nên các sự kiện đánh thức (`power/getPowerState` hoặc `getForegroundAppInfo`) không được xử lý tức thì.

### C. Vì sao "bị mất neo" và không thể vào được Launcher gốc của LG?
1. **Tiêu diệt tiến trình cưỡng bức trong `10-debloat`:**
   - Trong file `10-debloat`, có các lệnh `killall -9 com.webos.app.fullhome` chạy định kỳ ở các mốc 5s, 15s, 30s, 60s.
2. **Tự động chặn Launcher gốc trong `aerial-daemon.js`:**
   - Hàm `watchForeground()` trong daemon có cơ chế tự động: hễ thấy `STOCK_HOME` xuất hiện ở tiền cảnh là lập tức đóng (`lunaClose(STOCK_HOME, 'auto-suppress')`) và giật tiền cảnh về cho Aerial.
3. **Gán sai `defaultApps.home`:**
   - Lệnh `setSystemSettings` đã gán `defaultApps.home = "com.apple.aerial.tvos"`. Tuy nhiên, Aerial là một ứng dụng Web dạng Card (`defaultWindowType: "card"`), không phải ứng dụng hệ thống Native dạng Home (`defaultWindowType: "home"`). Việc gán này làm hệ điều hành Starfish/LSM không thể gọi được Launcher gốc khi người dùng bấm phím Home.

---

## 2. GIẢI PHÁP NEO MỚI: TẬNG DỤNG CƠ CHẾ CHÍNH QUY CỦA `bootd`

Thay vì can thiệp thô bạo (bind-mount đè file hệ thống, kill tiến trình liên tục), giải pháp chuẩn xác và bền vững nhất là:

### Điểm đột phá kỹ thuật: `/var/luna/preferences/bootd.json`
Mã nguồn nhị phân của `/usr/sbin/bootd` (LG Boot Manager) được lập trình để ưu tiên nạp cấu hình tùy biến tại:
`/var/luna/preferences/bootd.json` (thư mục ghi được trên phân vùng bộ nhớ TV), ghi đè cấu hình mặc định `/etc/palm/bootd.json`.

Khi ta cấu hình:
```json
{
    "common": {
        "firstApp": {
            "firstAppInFirstUse": "com.palm.app.firstuse",
            "firstAppInNormal": "com.apple.aerial.tvos",
            "firstAppInEmulator": "com.webos.app.emulwelcome"
        },
        "firstAppByPowerOnReason": {
            "netflix": "netflix",
            "amazon": "amazon",
            "ivi": "ivi",
            "remoteKey": "com.apple.aerial.tvos",
            "localKey": "com.apple.aerial.tvos"
        }
    }
}
```
**Kết quả đạt được:**
1. **Chính chủ & Tức thì:** Khi bật TV bằng remote (`remoteKey`) hay nút cứng (`localKey`), chính `bootd` sẽ phát lệnh mở `com.apple.aerial.tvos` làm ứng dụng đầu tiên.
2. **Không cướp quyền HDMI:** Bảng `inputApps` giữ nguyên (`HDMI_1 -> com.webos.app.hdmi1`). Khi người dùng chọn cổng HDMI, TV chạy HDMI mượt mà, không lỗi, không đen màn hình.
3. **Không cần kill tiến trình:** Hệ thống tự đưa Aerial lên trước mà không cần vòng lặp cưỡng chế.

---

## 3. KẾ HOẠCH HÀNH ĐỘNG CHI TIẾT (ACTION PLAN)

### Giai đoạn 1: Dọn dẹp & Hoàn nguyên hệ thống sạch sẽ (Rollback Clean)
- [ ] Gỡ bỏ các bind-mount bất thường trên TV:
  - `umount /etc/tvpowerd/tvpowerd.json`
  - `umount /etc/init/com.webos.app.inputcommon.conf`
- [ ] Xóa các file can thiệp tạm trong `/var/lib/webosbrew/`:
  - Xóa `/var/lib/webosbrew/tvpowerd.json`
  - Xóa `/var/lib/webosbrew/com.webos.app.inputcommon.conf`
- [ ] Phục hồi database cổng ngoại vi `/var/lib/eim/eim_device_db.json` về chuẩn ban đầu (`HDMI_1` trỏ về `com.webos.app.hdmi1`).
- [ ] Phục hồi cài đặt hệ thống: Gỡ `defaultApps.home` dị tật, trả về cấu hình tự nhiên của webOS.

### Giai đoạn 2: Kích hoạt Neo Boot chuẩn qua `/var/luna/preferences/bootd.json`
- [ ] Tạo file cấu hình boot chuẩn `/var/luna/preferences/bootd.json` chỉ định `firstAppInNormal` và `firstAppByPowerOnReason` về `com.apple.aerial.tvos`.
- [ ] Đồng bộ script `scripts/10-debloat`:
  - Loại bỏ các dòng `mount --bind` lỗi.
  - Loại bỏ hoàn toàn các lệnh `killall -9 com.webos.app.fullhome`.
  - Giữ lại các tinh chỉnh RAM, Swappiness, bộ đệm mạng và chặn tên miền quảng cáo.
- [ ] Sửa lỗi script `scripts/20-aerial-launcher`:
  - Thay thế `sleep 0.4` bằng vòng lặp poll an toàn với BusyBox (`sleep 1`).

### Giai đoạn 3: Tối ưu `aerial-daemon.js` - Quản lý nút Home & Giám sát nguồn
- [ ] Cấu hình lại nút **HOME (mã phím 773)**:
  - **Nhấn nhanh (Short press):** Chuyển về Apple TV Launcher (`com.apple.aerial.tvos`).
  - **Nhấn giữ >= 3 giây (Long press):** Mở Launcher gốc của LG (`com.webos.app.home`).
- [ ] Gỡ bỏ hàm chặn cưỡng chế `STOCK_HOME` trong `watchForeground()`, cho phép Launcher gốc hiển thị tự nhiên khi người dùng giữ phím.
- [ ] Tối ưu bộ lắng nghe nguồn Standby (Power State) để hỗ trợ kéo Aerial lên nếu người dùng bật TV từ chế độ nghỉ sâu.

### Giai đoạn 4: Bổ sung thẻ "HDMI 1" vào Dock của Launcher
- [ ] Thêm ứng dụng "HDMI 1" vào danh mục `tv_real_apps.json` và giao diện `src/index.html`:
  - Tên hiển thị: **HDMI 1**
  - Icon: Icon thiết bị / cổng kết nối tvOS tối giản sang trọng.
  - Hành động khi bấm Enter: Gọi `luna://com.webos.applicationManager/launch` với `id: "com.webos.app.hdmi1"`.
- [ ] Build lại giao diện và đồng bộ lên TV qua `./scripts/deploy.sh`.

### Giai đoạn 5: Kiểm thử toàn diện & Bàn giao
- [ ] Test 1: Khởi động nóng từ Standby (tắt bằng remote -> bật lại): Kiểm tra xem có vào thẳng Aerial Launcher không, còn màn hình đen HDMI không.
- [ ] Test 2: Bấm nút Home ngắn: Kiểm tra quay về Aerial Launcher mượt mà.
- [ ] Test 3: Bấm nút Home giữ 3 giây: Kiểm tra thanh Launcher gốc của LG xuất hiện đầy đủ.
- [ ] Test 4: Chọn icon "HDMI 1" trên Dock: Kiểm tra TV chuyển sang cổng HDMI 1 trơn tru, hiển thị hình ảnh bình thường.
- [ ] Test 5: Khi đang ở HDMI 1 bấm nút Home: Kiểm tra quay trở lại Aerial Launcher an toàn.
