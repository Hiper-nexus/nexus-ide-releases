#!/usr/bin/env python3
"""
BridgeSpace 3.4.18 — Tauri binary frontend carver.

Strategy:
  - Scan the Mach-O for embedded Vite asset keys (assets/<name>-<hash>.<ext>).
  - For each key, locate the asset content boundaries in the binary and write
    the recovered file to frontend/.

Phase 1 (this pass): inventory + hexdump probes around each key so we can
learn the framing format (length-prefixed? null-terminated? brotli chunk?).
Phase 2: carve bytes for the assets that are stored plaintext.
"""
import re
import sys
import json
from pathlib import Path

BIN = Path("/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri")
OUT = Path(__file__).resolve().parent.parent / "frontend"

ASSET_RE = re.compile(rb"assets/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?|ttf|wasm)")

def main():
    data = BIN.read_bytes()
    print(f"binary size: {len(data)} bytes")
    matches = list(ASSET_RE.finditer(data))
    print(f"asset key occurrences: {len(matches)}")

    seen = {}
    for m in matches:
        key = m.group().decode("latin1")
        if key not in seen:
            seen[key] = m.start()

    inventory = sorted(((off, k) for k, off in seen.items()))
    print(f"unique asset keys: {len(inventory)}")

    # Persist inventory
    OUT.mkdir(parents=True, exist_ok=True)
    inv = [{"offset": off, "asset": k} for off, k in inventory]
    (OUT / "_inventory.json").write_text(json.dumps(inv, indent=2))

    for off, k in inventory:
        # dump 48 bytes before and after the key for framing analysis
        pre = data[max(0, off - 48):off]
        post = data[off + len(k):off + len(k) + 64]
        print(f"\n=== {k} @ {off} ===")
        print("  pre :", pre.hex(" ")[-160:])
        print("  post:", post.hex(" ")[:160])
        print("  post ascii:", "".join(chr(b) if 32 <= b < 127 else "." for b in post[:64]))

if __name__ == "__main__":
    main()
