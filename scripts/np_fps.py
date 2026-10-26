#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, urllib.request, asyncio
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
        new Promise(resolve => {
          const N = 3000; let t0 = performance.now(); let frames = 0;
          let last = t0; let worst = 0; let longFrames = 0; const gaps = [];
          function step(t) {
            frames++;
            const dt = t - last; last = t;
            if (dt > worst) worst = dt;
            if (dt > 45) longFrames++;
            gaps.push(dt);
            if (t - t0 < N) requestAnimationFrame(step);
            else {
              const dur = (t - t0) / 1000;
              const fps = frames / dur;
              gaps.sort((a,b)=>a-b);
              const p50 = gaps[Math.floor(gaps.length*0.5)];
              const p95 = gaps[Math.floor(gaps.length*0.95)];
              resolve({ frames, dur: +dur.toFixed(2), fps: +fps.toFixed(1), worstMs: +worst.toFixed(1), longFrames, p50ms:+p50.toFixed(1), p95ms:+p95.toFixed(1) });
            }
          }
          requestAnimationFrame(step);
        })
        """
        r = await call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        print(json.dumps(r.get("result", {}).get("result", {}).get("value", {}), indent=2))

asyncio.run(main())
