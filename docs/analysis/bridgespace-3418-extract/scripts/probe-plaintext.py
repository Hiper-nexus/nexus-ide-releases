#!/usr/bin/env python3
"""Locate plaintext JS blobs and test compression framing."""
from pathlib import Path

BIN = Path("/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri")
data = BIN.read_bytes()

# distinctive plaintext markers seen via strings
markers = [
    b'sentry!function()',
    b'MainApp-Bsp7gQmz',
    b'import.meta',
    b'index.html',
    b'<!DOCTYPE html>',
    b'window.__TAURI_INTERNALS__',
]
for m in markers:
    off = data.find(m)
    print(f"{m!r:40s} first at {off}")
    if off >= 0:
        pre = data[max(0, off-32):off]
        print("   pre:", pre.hex(" "), "".join(chr(b) if 32<=b<127 else "." for b in pre))

# test brotli on bytes after first asset path
try:
    import brotli
    print("\nbrotli module available:", brotli.__version__)
except Exception as e:
    print("\nbrotli module missing:", e)

# framing test: after each asset key, try brotli decompress of [data after key up to next key]
import re
keys = [(m.start(), m.end(), m.group().decode()) for m in re.finditer(rb"assets/[\w\-.]+\.(?:js|css|svg|png)", data)]
keys.sort()
print("\nframing tests (key -> after-key bytes):")
for i, (s, e, name) in enumerate(keys[:8]):
    # bytes right after key
    after = data[e:e+16]
    # candidate: 4-byte LE length then data
    print(f"  {name}: after={after.hex(' ')}")
    # try interpreting first 4 bytes as u32 LE
    if len(after) >= 4:
        import struct
        val = struct.unpack('<I', after[:4])[0]
        print(f"     u32LE(after)={val}")
