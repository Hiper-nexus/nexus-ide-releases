#!/usr/bin/env node
/**
 * BridgeSpace Tauri binary — brotli framing probe.
 * Converts binary to latin1 string once (byte-preserving) to avoid OOM.
 */
const fs = require("fs");
const zlib = require("zlib");

const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const re = /\/assets\/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?|ttf)/g;
const entries = [];
let m;
while ((m = re.exec(s)) !== null) {
  entries.push({ key: m[0], start: m.index, end: m.index + m[0].length });
}
entries.sort((a, b) => a.start - b.start);
console.log("total asset keys:", entries.length);

function tryBrotli(buf) {
  try {
    const out = zlib.brotliDecompressSync(buf);
    return { ok: true, len: out.length, head: out.subarray(0, 60).toString("utf8") };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

console.log("\n=== orientation A: [path][brotli] (decompress after key up to next key) ===");
let okA = 0;
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const dataStart = e.end;
  const dataEnd = i + 1 < entries.length ? entries[i + 1].start : dataStart + 4096;
  const blob = bin.subarray(dataStart, dataEnd);
  const r = tryBrotli(blob);
  if (r.ok) {
    okA++;
    if (okA <= 6) {
      console.log(`OK   ${e.key}  blob=${blob.length}  out=${r.len}  head=${JSON.stringify(r.head)}`);
    }
  } else if (i < 3) {
    console.log(`FAIL ${e.key}  blob=${blob.length}  err=${r.err}`);
  }
}
console.log("orientation A ok count:", okA, "/", entries.length);

console.log("\n=== orientation B: [brotli][path] (decompress before key back to previous key end) ===");
let okB = 0;
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const dataEnd = e.start;
  const dataStart = i > 0 ? entries[i - 1].end : Math.max(0, dataEnd - 4096);
  if (dataEnd - dataStart <= 0) continue;
  const blob = bin.subarray(dataStart, dataEnd);
  const r = tryBrotli(blob);
  if (r.ok) {
    okB++;
    if (okB <= 6) {
      console.log(`OK   ${e.key}  blob=${blob.length}  out=${r.len}  head=${JSON.stringify(r.head)}`);
    }
  } else if (i < 3) {
    console.log(`FAIL ${e.key}  blob=${blob.length}  err=${r.err}`);
  }
}
console.log("orientation B ok count:", okB, "/", entries.length);
