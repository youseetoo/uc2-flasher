"""Docker build step: download the page's CDN assets into <web>/vendor and point
index.html at them, so the flasher works on a microscope without internet.
esp-web-tools / esptool-js stay on the CDN: they are only used in WebSerial mode.

    python vendor_assets.py /app/web
"""
import re
import sys
import urllib.request
from pathlib import Path

ASSETS = {
    "https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css": "bootstrap.min.css",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/js/bootstrap.bundle.min.js": "bootstrap.bundle.min.js",
    "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css": "bootstrap-icons.css",
    "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/fonts/bootstrap-icons.woff2": "fonts/bootstrap-icons.woff2",
    "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/fonts/bootstrap-icons.woff": "fonts/bootstrap-icons.woff",
}

web = Path(sys.argv[1])
(web / "vendor" / "fonts").mkdir(parents=True, exist_ok=True)
for url, name in ASSETS.items():
    urllib.request.urlretrieve(url, web / "vendor" / name)
index = web / "index.html"
html = index.read_text()
for url, name in ASSETS.items():
    html = html.replace(url, f"vendor/{name}")
missing = [u for u in re.findall(r'(?:href|src)="(https://cdn[^"]+)"', html)]
if missing:
    sys.exit(f"index.html references CDN assets that are not vendored: {missing}")
index.write_text(html)
print(f"vendored {len(ASSETS)} assets into {web / 'vendor'}")
