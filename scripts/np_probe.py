#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Probe the now-playing overlay on the LG TV without reloading:
  - fetch http://127.0.0.1:8899/state FROM the app context (tests bridge reachability)
  - report the NowPlaying overlay DOM state (visible / art / title / lyric lines)
  - capture a live screenshot to docs/screenshots/np_capture.jpg
"""

import os
import json
import base64
import urllib.request
import asyncio
import websockets

TV_IP = "192.168.1.6"
CDP_PORT = 9998
SHOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs", "screenshots", "np_capture.jpg",
)


async def main():
    tabs = json.loads(urllib.request.urlopen(f"http://{TV_IP}:{CDP_PORT}/json", timeout=3).read().decode())
    target = tabs[0]
    ws_url = target["webSocketDebuggerUrl"]
    print("CDP:", ws_url, "|", target.get("url", ""))

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

        dom = """
        (() => {
          const np = document.getElementById('nowPlaying');
          const art = document.getElementById('npArt');
          const track = document.getElementById('npLyricsTrack');
          const lines = track ? track.querySelectorAll('.np-line') : [];
          const active = track ? track.querySelector('.np-line.active') : null;
          return {
            hasElement: !!np,
            classes: np ? np.className : null,
            opacity: np ? getComputedStyle(np).opacity : null,
            title: (document.getElementById('npTitle')||{}).textContent || '',
            artist: (document.getElementById('npArtist')||{}).textContent || '',
            album: (document.getElementById('npAlbum')||{}).textContent || '',
            artSrc: art ? art.getAttribute('src') : null,
            artLoaded: art ? art.classList.contains('loaded') : null,
            lineCount: lines.length,
            activeText: active ? active.textContent : null,
            trackY: track ? getComputedStyle(track).transform : null
          };
        })()
        """
        r = await call("Runtime.evaluate", {"expression": dom, "returnByValue": True})
        print("DOM:", json.dumps(r.get("result", {}).get("result", {}).get("value", {}), indent=2, ensure_ascii=False))

        fetchprobe = """
        fetch('http://127.0.0.1:8899/state?t=' + Date.now())
          .then(r => r.json())
          .then(j => ({ ok: true, active: j.active, title: j.title, artist: j.artist,
                        hasArt: j.hasArt, artSeq: j.artSeq,
                        hasLyrics: !!(j.lyrics || j.lyricsSynced), progress: j.progress }))
          .catch(e => ({ ok: false, error: String(e) }))
        """
        r = await call("Runtime.evaluate", {"expression": fetchprobe, "returnByValue": True, "awaitPromise": True})
        print("FETCH:", json.dumps(r.get("result", {}).get("result", {}).get("value", {}), indent=2, ensure_ascii=False))

        r = await call("Page.captureScreenshot", {"format": "jpeg", "quality": 80})
        data = r.get("result", {}).get("data")
        if data:
            os.makedirs(os.path.dirname(SHOT), exist_ok=True)
            with open(SHOT, "wb") as f:
                f.write(base64.b64decode(data))
            print("Screenshot ->", SHOT, "(%d bytes)" % os.path.getsize(SHOT))


if __name__ == "__main__":
    asyncio.run(main())
