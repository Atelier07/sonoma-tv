#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, urllib.request, asyncio, base64, os, sys
import websockets

TV_IP = "192.168.1.6"; CDP_PORT = 9998

async def main():
    tabs = json.loads(urllib.request.urlopen(f"http://{TV_IP}:{CDP_PORT}/json", timeout=3).read().decode())
    ws_url = tabs[0]["webSocketDebuggerUrl"]
    async with websockets.connect(ws_url, max_size=None) as ws:
        c = [0]
        async def call(m, p=None):
            c[0] += 1; mid = c[0]
            await ws.send(json.dumps({"id": mid, "method": m, "params": p or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == mid:
                    return msg
        expr = """
        (() => {
          const track = document.getElementById('npLyricsTrack');
          const act = track ? track.querySelector('.np-line.active') : null;
          const fam = getComputedStyle(document.body).fontFamily;
          let loaded = [];
          try { document.fonts.forEach(f => { if (f.family.indexOf('Inter')>=0) loaded.push(f.family+':'+f.weight+':'+f.status); }); } catch(e){}
          const vids = ['aerialVideo','aerialVideoNext'].map(id => {
            const v = document.getElementById(id);
            return { id, paused: v? v.paused:null, rs: v? v.readyState:null, src: v? (v.currentSrc||'').split('/').pop():null };
          });
          return {
            bodyFont: fam,
            interLoaded: loaded,
            interCheck600: (document.fonts && document.fonts.check) ? document.fonts.check('600 2rem Inter') : null,
            trackLines: track ? track.children.length : -1,
            activeText: act ? act.textContent : null,
            mtvSuspended: window.__mtv ? window.__mtv.suspended : null,
            videos: vids
          };
        })()
        """
        r = await call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        print(json.dumps(r.get("result", {}).get("result", {}).get("value", {}), indent=2, ensure_ascii=False))
        shot = await call("Page.captureScreenshot", {"format": "jpeg", "quality": 80})
        data = shot.get("result", {}).get("data")
        if data:
            out = "/Users/macbook/Documents/Projects/webos-tvos-launcher/docs/screenshots/np_capture.jpg"
            open(out, "wb").write(base64.b64decode(data))
            print("shot ->", out, os.path.getsize(out))

asyncio.run(main())
