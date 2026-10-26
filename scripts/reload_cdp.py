#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Connects to Chrome Remote Debugging port 9998 on LG TV,
reloads the current launcher page, and captures a live screenshot.
"""

import os
import json
import base64
import urllib.request
import asyncio
import websockets

TV_IP = "192.168.1.6"
CDP_PORT = 9998
SCREENSHOT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs", "screenshots", "live_capture.jpg"
)

async def reload_and_capture():
    try:
        url = f"http://{TV_IP}:{CDP_PORT}/json"
        resp = urllib.request.urlopen(url, timeout=3)
        tabs = json.loads(resp.read().decode())
        if not tabs:
            print("No active inspectable tabs on TV.")
            return

        launcher_tab = next((t for t in tabs if "com.apple.aerial.tvos" in t.get("url", "") or "tvOS" in t.get("title", "")), tabs[0])
        ws_url = launcher_tab["webSocketDebuggerUrl"]
        print(f"Connecting to CDP ({launcher_tab.get('title')}): {ws_url}")

        async with websockets.connect(ws_url) as ws:
            # 1. Reload page
            await ws.send(json.dumps({"id": 1, "method": "Page.reload", "params": {"ignoreCache": True}}))
            res = await ws.recv()
            print("Page.reload response:", res)

            # 2. Wait for DOM and Video to settle
            await asyncio.sleep(2.5)

            # 3. Capture screenshot
            await ws.send(json.dumps({
                "id": 2,
                "method": "Page.captureScreenshot",
                "params": {"format": "jpeg", "quality": 75}
            }))
            msg = await ws.recv()
            data = json.loads(msg)
            if "result" in data and "data" in data["result"]:
                img_bytes = base64.b64decode(data["result"]["data"])
                os.makedirs(os.path.dirname(SCREENSHOT_PATH), exist_ok=True)
                with open(SCREENSHOT_PATH, "wb") as f:
                    f.write(img_bytes)
                print(f"Captured live screenshot -> {SCREENSHOT_PATH} ({len(img_bytes)} bytes)")

            # 4. Query current TV state
            eval_script = """
            (() => {
                const v = document.getElementById('aerialVideo');
                const focused = document.querySelector('.app-card.focused');
                return {
                    clock: document.getElementById('clockText') ? document.getElementById('clockText').textContent : '',
                    temp: document.getElementById('weatherTemp') ? document.getElementById('weatherTemp').textContent : '',
                    videoPlaying: v ? (!v.paused && v.currentTime > 0) : false,
                    focusedApp: focused ? focused.dataset.title : null
                };
            })()
            """
            await ws.send(json.dumps({"id": 3, "method": "Runtime.evaluate", "params": {"expression": eval_script, "returnByValue": True}}))
            msg = await ws.recv()
            state = json.loads(msg).get("result", {}).get("result", {}).get("value", {})
            print("Live TV Status:", json.dumps(state, indent=2, ensure_ascii=False))

    except Exception as e:
        print(f"Error connecting to TV CDP: {e}")

if __name__ == "__main__":
    asyncio.run(reload_and_capture())
