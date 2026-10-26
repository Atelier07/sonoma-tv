#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Simulates remote control keypresses (Left, Right, Up, Down, OK) on the TV via CDP.
Usage:
  python3 test_remote.py right
  python3 test_remote.py left
  python3 test_remote.py up
  python3 test_remote.py down
  python3 test_remote.py enter
"""

import sys
import json
import urllib.request
import asyncio
import websockets

TV_IP = "192.168.1.6"
CDP_PORT = 9998

KEYS = {
    "left": 37,
    "up": 38,
    "right": 39,
    "down": 40,
    "enter": 13,
    "ok": 13,
    "back": 461
}

async def send_key(key_name):
    if key_name.lower() not in KEYS:
        print(f"Unknown key '{key_name}'. Supported: {list(KEYS.keys())}")
        return

    code = KEYS[key_name.lower()]

    try:
        url = f"http://{TV_IP}:{CDP_PORT}/json"
        resp = urllib.request.urlopen(url, timeout=3)
        tabs = json.loads(resp.read().decode())
        ws_url = tabs[0]["webSocketDebuggerUrl"]

        async with websockets.connect(ws_url) as ws:
            press_cmd = f"""
            (() => {{
                const ev = document.createEvent('Event');
                ev.initEvent('keydown', true, true);
                ev.keyCode = {code};
                window.dispatchEvent(ev);
                const focused = document.querySelector('.app-card.focused');
                return {{
                    action: '{key_name}',
                    keyCode: {code},
                    dockOpen: document.body.classList.contains('dock-open'),
                    focusedApp: focused ? focused.dataset.title : null
                }};
            }})()
            """
            await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": press_cmd, "returnByValue": True}}))
            msg = await ws.recv()
            result = json.loads(msg).get("result", {}).get("result", {}).get("value", {})
            print("Remote Action Result:", json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Error sending key: {e}")

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "right"
    asyncio.run(send_key(action))
