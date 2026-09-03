#!/usr/bin/env python3
"""Probe the binary framing around asset keys."""
import re, sys
from pathlib import Path

BIN = Path("/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri")
data = BIN.read_bytes()

def find_key(pat: bytes):
    i = data.find(pat)
    return i

def dump(off, before=96, after=160, label=""):
    print(f"--- {label} @ {off} ---")
    pre = data[max(0, off - before):off]
    post = data[off:off + after]
    print("pre :", pre.hex(" "))
    print("post:", post.hex(" "))
    print("pre ascii :", "".join(chr(b) if 32 <= b < 127 else "." for b in pre))
    print("post ascii:", "".join(chr(b) if 32 <= b < 127 else "." for b in post))

# First asset key occurrence
first = re.search(rb"assets/[\w\-.]+\.(?:js|css|svg)", data)
print("first asset key at", first.start(), first.group())
dump(first.start(), label=first.group().decode())

# MainApp key
k = find_key(b"/assets/MainApp-Bsp7gQmz.js")
print("\nMainApp with leading slash:", k)
dump(k, label="MainApp-slash")

# Look at what's between consecutive keys: find all keys with offsets
keys = [(m.start(), m.group().decode()) for m in re.finditer(rb"assets/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?)", data)]
keys.sort()
print("\nfirst 12 keys by offset:")
for off, name in keys[:12]:
    print(f"  {off:>10}  {name}")
# gaps
print("\ngaps between consecutive keys:")
for (o1, n1), (o2, n2) in zip(keys[:12], keys[1:13]):
    gap = o2 - o1
    print(f"  {n1:45s} -> {n2:45s} gap={gap} (keylen={len(n1)})")
