# Cơ chế Root & Hàng rào bảo vệ TV LG (webOS 4.5)

## 1. Bản chất sự cố mất app khi tắt TV

Trước khi root, TV sử dụng tài khoản LG Developer Mode. LG thiết kế một cơ chế kiểm soát rất nghiêm ngặt:
- Khi bật TV hoặc sau mỗi khoảng thời gian định kỳ, script `/media/cryptofs/apps/usr/palm/services/com.palmdts.devmode.service/start-devmode.sh` được kích hoạt.
- Script này gửi token về máy chủ `https://developer.lge.com/secure/CheckDevModeSession.dev`.
- Nếu token hết hạn (mặc định 50 giờ), hoặc nếu TV khởi động khi chưa kịp cấp phát địa chỉ IP/kết nối internet, kết quả trả về là `"fail"`.
- Khi đó, script thực thi:
  ```sh
  rm -rf /var/luna/preferences/devmode_enabled
  rm -rf /media/developer/apps/*
  ```
- Kết quả: Toàn bộ ứng dụng của người dùng tự động bị xóa sổ.

---

## 2. Quy trình bẻ khóa Root (Jailbreak)

1. **Khai thác lỗ hổng `faultmanager`:**
   - Dịch vụ `faultmanager` trên webOS 4.0 - 10.0 chạy với quyền `root` (`uid=0`).
   - Lợi dụng việc `faultmanager` thực thi các chuỗi lệnh được lưu trong tên nhãn (comm) khi một tiến trình liên kết với `libSegFault` gặp lỗi phân đoạn (Segmentation Fault).
   - Script `autoroot.sh` tạo symlink đến Python với tên đặc biệt chứa chuỗi lệnh nâng quyền, sau đó gửi tín hiệu `SIGSEGV` (11) để ép tiến trình sập.
   - `faultmanager` bắt được sự cố và thực thi payload với quyền `uid=0 (root)`.

2. **Cài đặt & Nâng quyền Homebrew Channel:**
   - Cài đặt gói `org.webosbrew.hbchannel_0.7.3_all.ipk` qua `luna://com.webos.appInstallService/dev/install`.
   - Chạy script `/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service` để cập nhật vai trò (roles) và quyền (permissions) của Homebrew Channel trong Luna Service Bus, cấp quyền truy cập không giới hạn (`*`).

---

## 3. Các biện pháp chống tước quyền Root & Chống xóa App

1. **Gỡ bỏ vĩnh viễn app Developer Mode:**
   - Đã gỡ bỏ package `com.palmdts.devmode` qua lệnh:
     ```sh
     luna-send -n 1 -f 'luna://com.webos.appInstallService/remove' '{"id":"com.palmdts.devmode"}'
     ```
   - Thư mục `/media/cryptofs/apps/usr/palm/services/com.palmdts.devmode.service/start-devmode.sh` đã bị loại bỏ hoàn toàn.

2. **Khóa bất tử cờ Developer:**
   - Tạo thư mục `/var/luna/preferences/devmode_enabled` và gán thuộc tính Linux Immutable:
     ```sh
     chattr +i /var/luna/preferences/devmode_enabled
     ```
   - Khi có cờ này, webOS luôn cho phép chạy các app tự phát triển và không bao giờ tự ý khóa môi trường.

3. **Chặn máy chủ cập nhật LG Update Server:**
   - Ghi đè vào `/etc/hosts` trỏ các domain sau về `127.0.0.1`:
     - `snu.lge.com` (máy chủ tải bản cập nhật firmware)
     - `su.lge.com`
     - `su-ssl.lge.com`
     - `su-dev.lge.com`
     - `lgtvonline.lge.com`
     - `lgsmartad.com`
     - `ibis.lgappstv.com`
   - Kích hoạt cờ tự động mount lúc boot: `touch /var/luna/preferences/webosbrew_block_updates`.
   - Ngăn chặn triệt để tình trạng LG tự ý tải firmware mới về vá lỗ hổng hoặc xóa Homebrew Channel.

4. **Kích hoạt SSH & Telnet dự phòng:**
   - Khởi động Dropbear SSH Root trên port 22 bằng khóa `~/.ssh/webos_rsa`.
   - Khởi động Telnet Root trên port 23 qua `/var/lib/webosbrew/startup.sh`.
