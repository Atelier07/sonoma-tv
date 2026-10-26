#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Inspect the active lyric line's word spans (karaoke highlight) on the TV."""

import json
import urllib.request
import asyncio
import websockets

TV_IP = "192.168.1.6"
CDP_PORT = 9998


async def main():
    tabs = json.loads(urllib.request.urlopen(f"http://{TV_IP}:{CDP_PORT}/json", timeout=3).read().decode())
    ws_url = tabs[0]["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=None) as ws:
        counter = [0]

        async def call(method, params=None):
            counter[0] += 1
            mid = counter[0]
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == mid:
                    return msg

        expr = """
        (() => {
          const track = document.getElementById('npLyricsTrack');
          if (!track) return { err: 'no track' };
          const active = track.querySelector('.np-line.active');
          const bg = document.getElementById('npBg');
          const words = active ? Array.from(active.querySelectorAll('.np-w')) : [];
          return {
            activeText: active ? active.textContent : null,
            words: words.map(w => ({
              t: w.textContent,
              cls: w.className,
              color: getComputedStyle(w).color,
              fill: getComputedStyle(w).webkitTextFillColor,
              pos: w.style.backgroundPosition,
              clip: getComputedStyle(w).webkitBackgroundClip || getComputedStyle(w).backgroundClip
            })),
            bgImage: bg ? (getComputedStyle(bg).backgroundImage || '').slice(0, 140) : null
          };
        })()
        """
        r = await call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        val = r.get("result", {}).get("result", {}).get("value", {})
        print(json.dumps(val, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
