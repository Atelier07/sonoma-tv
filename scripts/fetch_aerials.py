#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fetch Apple TV aerial screensaver manifest and build src/aerials.json.

Apple publishes the screensaver catalog inside a tarball, e.g.
    https://sylvan.apple.com/Aerials/resources-16.tar
which contains an ``entries.json`` describing every asset. Each asset lists
multiple encodings:

    url-4K-HDR / url-4K-SDR   -> 3840x2160 HEVC (.mov)
    url-1080-HDR / url-1080-SDR -> 1920x1080 HEVC (.mov)
    url-1080-H264             -> 1920x1080 H.264 (.mov)

On the target LG webOS 4.5 TV (Chromium 53) hardware tests showed that
**only the HEVC variants decode through the VPU**; the H.264 .mov track is
not decoded. The panel is 1920x1080 native, so 1080p is a 1:1 pixel match
and 4K only costs extra VPU decode (measured ~48 FPS vs ~60 FPS). This
script therefore prefers the ``url-1080-SDR`` variant (falls back to 4K),
and writes a compact catalog consumed by the launcher.

The launcher streams these URLs directly and never writes them to ROM.
"""

import io
import json
import os
import re
import sys
import tarfile
import urllib.request
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JSON = os.path.join(BASE_DIR, "src", "aerials.json")

# tvOS 16 bundle currently holds the newest catalog; fall back to older ones.
TARBALLS = [
    "https://sylvan.apple.com/Aerials/resources-16.tar",
    "https://sylvan.apple.com/Aerials/resources-15.tar",
    "https://sylvan.apple.com/Aerials/resources.tar",
]

WANT = 114         # how many clips to keep in the rotation (114 = full Apple catalog)
ALLOWED_COUNTRIES = None  # None = no filter


def fetch_entries():
    last_err = None
    for url in TARBALLS:
        try:
            sys.stderr.write("Downloading %s ...\n" % url)
            raw = urllib.request.urlopen(url, timeout=60).read()
            with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
                names = [n for n in tar.getnames() if n.endswith("entries.json")]
                if not names:
                    continue
                f = tar.extractfile(names[0])
                return json.loads(f.read().decode("utf-8")), url
        except Exception as e:  # noqa: BLE001 - report and try next mirror
            last_err = e
            sys.stderr.write("  failed: %s\n" % e)
    raise SystemExit("Could not fetch any Apple aerial manifest: %s" % last_err)


def clean_label(asset):
    label = asset.get("accessibilityLabel") or asset.get("shotID") or "Aerial"
    # Trim the localized suffix Apple sometimes appends, e.g. "Greenland_4K".
    return re.sub(r"[_ ]*(4K|HDR|SDR|HEVC)$", "", label).strip()


def build():
    entries, used_url = fetch_entries()
    assets = entries.get("assets", entries if isinstance(entries, list) else [])

    seen = set()
    clips = []
    for a in assets:
        url = a.get("url-1080-SDR") or a.get("url-4K-SDR")
        if not url:
            continue
        shot = a.get("shotID") or a.get("id") or url
        if shot in seen:
            continue
        seen.add(shot)
        clips.append({
            "label": clean_label(a),
            "shotID": shot,
            "url": url,
        })

    # Deterministic, varied selection: sort by label then take an even stride.
    clips.sort(key=lambda c: c["label"].lower())
    n = len(clips)
    if n > WANT:
        step = n / float(WANT)
        picked, used = [], set()
        for i in range(WANT):
            idx = min(n - 1, int(i * step))
            while idx in used and idx < n - 1:
                idx += 1
            used.add(idx)
            picked.append(clips[idx])
        clips = picked

    doc = {
        "source": used_url,
        "variant": "url-1080-SDR (fallback 4K)",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "clips": clips,
    }

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")

    total = len(clips)
    sys.stderr.write("Wrote %d clips -> %s\n" % (total, OUT_JSON))
    for c in clips:
        print("  - %-28s %s" % (c["label"], c["url"]))


if __name__ == "__main__":
    build()
