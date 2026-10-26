#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chụp ảnh màn hình TV (LG webOS) từ xa qua Chrome DevTools Protocol (Port 9998).
Sử dụng:
  python3 scripts/screenshot.py         # Chụp trạng thái hiện tại trên TV
  python3 scripts/screenshot.py --dock  # Đánh thức thanh Dock rồi chụp
  python3 scripts/screenshot.py --open  # Chụp và tự động mở xem ảnh trên Mac
"""

import sys
import os
import json
import base64
import urllib.request
import asyncio
import argparse

try:
    import websockets
except ImportError:
    print("Vui lòng cài đặt websockets: pip3 install websockets")
    sys.exit(1)

TV_IP = "192.168.1.6"
CDP_PORT = 9998
DEFAULT_OUTPUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs", "screenshots", "tv_screenshot.png"
)

async def capture(show_dock=False, open_after=False, out_path=DEFAULT_OUTPUT):
    try:
        url = f"http://{TV_IP}:{CDP_PORT}/json"
        resp = urllib.request.urlopen(url, timeout=3)
        tabs = json.loads(resp.read().decode())
        if not tabs:
            print("❌ Không tìm thấy tab nào đang chạy trên TV.")
            return

        target = next((t for t in tabs if "com.apple.aerial.tvos" in t.get("url", "") or "tvOS" in t.get("title", "")), tabs[0])
        ws_url = target["webSocketDebuggerUrl"]
        print(f"📡 Đang kết nối tới TV ({target.get('title', 'Unknown')}): {ws_url}")

        async with websockets.connect(ws_url) as ws:
            if show_dock:
                print("✨ Đang kích hoạt thanh Dock hiển thị...")
                await ws.send(json.dumps({
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": "if (window.__mtv && window.__mtv.showDock) window.__mtv.showDock(); else document.dispatchEvent(new KeyboardEvent('keydown', {keyCode: 40}));"}
                }))
                await ws.recv()
                await asyncio.sleep(0.5)

            print("📸 Đang chụp ảnh màn hình (1920x1080)...")
            await ws.send(json.dumps({
                "id": 2,
                "method": "Page.captureScreenshot",
                "params": {"format": "png"}
            }))
            res = json.loads(await ws.recv())

            if "result" in res and "data" in res["result"]:
                img_bytes = base64.b64decode(res["result"]["data"])
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(img_bytes)
                print(f"✅ Đã chụp thành công: {out_path} ({len(img_bytes)} bytes)")

                if open_after:
                    os.system(f"open '{out_path}'")
            else:
                print("❌ Lỗi: Không nhận được dữ liệu ảnh từ TV.", res)

    except Exception as e:
        print(f"❌ Lỗi kết nối tới TV ({TV_IP}:{CDP_PORT}): {e}")

def main():
    parser = argparse.ArgumentParser(description="Chụp ảnh màn hình TV LG từ xa.")
    parser.add_argument("--dock", action="store_true", help="Hiện thanh Dock trước khi chụp")
    parser.add_argument("--open", action="store_true", help="Mở ảnh ngay trên máy tính sau khi chụp")
    parser.add_argument("--out", type=str, default=DEFAULT_OUTPUT, help="Đường dẫn file ảnh đầu ra")
    args = parser.parse_args()

    asyncio.run(capture(show_dock=args.dock, open_after=args.open, out_path=args.out))

if __name__ == "__main__":
    main()
