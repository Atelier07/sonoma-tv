#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build script for tvOS Minimal Launcher on webOS.

Regenerates the applications block in src/index.html using the
"dark glass tile + colored app icon" (Apple TV style) design:

  - each card is a 3:2 dark glass squircle (styled by ``.card-surface``),
  - a colored brand icon is a rounded square (``.card-icon``) centered on
    top; its gradient is set as the inline CSS custom property
    ``--icon-bg``, and
  - a single white vector glyph (24x24 viewBox) sits inside the icon.

The surrounding CSS/JS in src/index.html is left untouched; only the
``<div class="apps-wrapper" id="appsWrapper"> ... </div>`` block is
replaced. Running this script must be idempotent (it should not change
the file if nothing in the app list changed).
"""

import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_HTML = os.path.join(BASE_DIR, "src", "index.html")
AERIALS_JSON = os.path.join(BASE_DIR, "src", "aerials.json")


def _svg(*child_lines):
    """Wrap glyph child elements in a 24x24 white SVG on a transparent bg.

    Indentation is baked in so that, when the snippet is interpolated at
    18 spaces in the card template, the result matches the hand-authored
    markup exactly (open/close tag at 18, children at 20).
    """
    body = "\n".join("                    " + line for line in child_lines)
    return '<svg viewBox="0 0 24 24" fill="none">\n' + body + "\n                  </svg>"


apps = [
    {
        "id": "youtube.leanback.v4",
        "title": "YouTube",
        "grad": "linear-gradient(140deg, #FF5252 0%, #E60000 58%, #B00000 100%)",
        "svg": _svg(
            '<rect x="2.6" y="5.4" width="18.8" height="13.2" rx="4.4" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M10.1 9.3l5.3 2.7-5.3 2.7z" fill="#fff"/>',
        ),
    },
    {
        "id": "spotify-beehive",
        "title": "Spotify",
        "grad": "linear-gradient(140deg, #1ED760 0%, #1DB954 58%, #0F8A3D 100%)",
        "svg": _svg(
            '<path d="M4.4 8.6C9 6.6 15.4 7 19.6 9.5" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M5.4 12.2C9.4 10.8 14.8 11.2 18.5 13.3" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M6.4 15.6C9.9 14.6 14.2 15 17.4 16.6" stroke="#fff" stroke-width="1.7"/>',
        ),
    },
    {
        "id": "com.apple.applemusic",
        "title": "Apple Music",
        "grad": "linear-gradient(140deg, #FB5C74 0%, #FA233B 58%, #C2152A 100%)",
        "svg": _svg(
            '<path d="M9 17.5V6.2l9-2v11.1" stroke="#fff" stroke-width="1.7"/>',
            '<circle cx="7" cy="17.6" r="2.1" fill="#fff"/>',
            '<circle cx="16" cy="15.6" r="2.1" fill="#fff"/>',
        ),
    },
    {
        "id": "com.webos.app.browser",
        "title": "Trình duyệt web",
        "grad": "linear-gradient(140deg, #60A5FA 0%, #2563EB 58%, #1D4ED8 100%)",
        "svg": _svg(
            '<circle cx="12" cy="12" r="8.6" stroke="#fff" stroke-width="1.7"/>',
            '<ellipse cx="12" cy="12" rx="3.9" ry="8.6" stroke="#fff" stroke-width="1.5"/>',
            '<path d="M3.6 9.4h16.8M3.6 14.6h16.8" stroke="#fff" stroke-width="1.5"/>',
        ),
    },
    {
        "id": "com.instantbits.cast.webvideo",
        "title": "Web Video Caster",
        "grad": "linear-gradient(140deg, #FDBA4D 0%, #F97316 58%, #C2410C 100%)",
        "svg": _svg(
            '<rect x="3.6" y="4.4" width="16.8" height="11.4" rx="2.4" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M11.1 8.5l4 2.6-4 2.6z" fill="#fff"/>',
            '<path d="M3.8 15.4a5.2 5.2 0 0 1 5.2 5.2" stroke="#fff" stroke-width="1.7"/>',
            '<circle cx="4" cy="20.5" r="1.1" fill="#fff"/>',
        ),
    },
    {
        "id": "com.webos.app.homeconnect",
        "title": "Bảng điều khiển nhà",
        "grad": "linear-gradient(140deg, #38BDF8 0%, #0EA5E9 58%, #0369A1 100%)",
        "svg": _svg(
            '<path d="M3.6 11.2L12 4l8.4 7.2" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M5.8 10.1V19.6h12.4V10.1" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M10.2 19.6v-4.2h3.6v4.2" stroke="#fff" stroke-width="1.7"/>',
        ),
    },
    {
        "id": "com.webos.app.photovideo",
        "title": "Ảnh & Video",
        "grad": "linear-gradient(140deg, #A78BFA 0%, #7C3AED 58%, #5B21B6 100%)",
        "svg": _svg(
            '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.6" stroke="#fff" stroke-width="1.7"/>',
            '<circle cx="8" cy="10" r="1.7" fill="#fff"/>',
            '<path d="M4.6 16.6l4-4 2.7 2.7 3.6-4.4 4 5.1" stroke="#fff" stroke-width="1.7"/>',
        ),
    },
    {
        "id": "com.webos.app.music",
        "title": "Âm nhạc",
        "grad": "linear-gradient(140deg, #F472B6 0%, #DB2777 58%, #9D174D 100%)",
        "svg": _svg(
            '<circle cx="12" cy="12" r="8.6" stroke="#fff" stroke-width="1.7"/>',
            '<circle cx="12" cy="12" r="5.6" stroke="#fff" stroke-width="1.1" opacity="0.6"/>',
            '<circle cx="12" cy="12" r="2.2" fill="#fff"/>',
        ),
    },
    {
        "id": "com.webos.app.discovery",
        "title": "LG Content Store",
        "grad": "linear-gradient(140deg, #F43F8E 0%, #D7156D 58%, #9D0F4F 100%)",
        "svg": _svg(
            '<path d="M5.4 8.2h13.2l1 11.2H4.4z" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M8.8 8.2a3.2 3.2 0 0 1 6.4 0" stroke="#fff" stroke-width="1.7"/>',
            '<circle cx="12" cy="13.6" r="1.4" fill="#fff"/>',
        ),
    },
    {
        "id": "org.webosbrew.hbchannel",
        "title": "Homebrew Channel",
        "grad": "linear-gradient(140deg, #FB7185 0%, #E11D48 58%, #9F1239 100%)",
        "svg": _svg(
            '<path d="M5 8h11v9.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 17.5z" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M16 10h1.8a2.2 2.2 0 0 1 0 4.4H16" stroke="#fff" stroke-width="1.7"/>',
            '<path d="M7.6 5.4c0-.9.9-1.3.9-1.3s.9.4.9 1.3M11 5.4c0-.9.9-1.3.9-1.3s.9.4.9 1.3M14.4 5.4c0-.9.9-1.3.9-1.3s.9.4.9 1.3" stroke="#fff" stroke-width="1.5"/>',
        ),
    },
]

cards_html = []
for idx, a in enumerate(apps):
    focus_cls = " focused" if idx == 0 else ""
    c = f'''            <button class="app-card{focus_cls}"
              data-index="{idx}"
              data-appid="{a["id"]}"
              data-title="{a["title"]}">
              <div class="card-surface">
                <div class="card-icon" style="--icon-bg: {a["grad"]};">
                  {a["svg"]}
                </div>
              </div>
            </button>'''
    cards_html.append(c)

cards_snippet = "\n".join(cards_html)


def render_aerials():
    """Render the inline ``var AERIALS = [...]`` block from src/aerials.json.

    Returns None (and leaves the block untouched) when aerials.json is absent,
    so the script stays usable without a network fetch.
    """
    if not os.path.exists(AERIALS_JSON):
        return None
    with open(AERIALS_JSON, "r", encoding="utf-8") as f:
        doc = json.load(f)
    clips = doc.get("clips", [])
    lines = [
        "    // <<AERIALS>>",
        "    // Danh sách clip 4K HEVC chính chủ Apple (sinh bởi scripts/fetch_aerials.py).",
        "    // Stream trực tiếp qua mạng LAN, KHÔNG ghi vào ROM. Nguồn: src/aerials.json.",
        "    var AERIALS = [",
    ]
    for i, c in enumerate(clips):
        comma = "," if i < len(clips) - 1 else ""
        lines.append(
            "      { label: %s, url: %s }%s"
            % (json.dumps(c["label"], ensure_ascii=False), json.dumps(c["url"]), comma)
        )
    lines.append("    ];")
    lines.append("    // <</AERIALS>>")
    return "\n".join(lines)


with open(TARGET_HTML, "r", encoding="utf-8") as f:
    current_content = f.read()

new_content = re.sub(
    r'<div class="apps-wrapper" id="appsWrapper">.*?</div>\s*</div>\s*</div>',
    f'<div class="apps-wrapper" id="appsWrapper">\n{cards_snippet}\n          </div>\n        </div>\n      </div>',
    current_content,
    flags=re.DOTALL,
)

aerials_block = render_aerials()
if aerials_block is not None:
    new_content = re.sub(
        r"[ \t]*// <<AERIALS>>.*?// <</AERIALS>>",
        aerials_block,
        new_content,
        flags=re.DOTALL,
    )

if new_content == current_content:
    print(f"No changes -> {TARGET_HTML} already up to date ({len(current_content)} bytes)")
else:
    with open(TARGET_HTML, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"Build complete -> {TARGET_HTML} ({len(new_content)} bytes)")
