#!/usr/bin/env node
/** Probe before first asset key for a brotli stream (index.html?). */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const first = s.indexOf("/assets/UpdateNotificationModal-as7iX6qL.js");
console.log("first key at", first);

// walk backwards trying brotli decompress ending at `first`
for (let start = first - 100000; start < first; start += 512) {
  try {
    const out = zlib.brotliDecompressSync(bin.subarray(start, first));
    if (out.length > 50) {
      console.log(`OK start=${start} (${first - start} bytes) out=${out.length} head=${JSON.stringify(out.subarray(0, 80).toString("utf8"))}`);
    }
  } catch {}
}

// Also scan forward from first key for a second key not matching /assets/
console.log("\n=== keys after last /assets/ key (region scan) ===");
const lastAssets = s.lastIndexOf("/assets/");
const re = /\/[\w][\w\-. ]{0,60}/g;
let m;
const hits = [];
while ((m = re.exec(s.slice(23657228, 23800000))) !== null) hits.push({ off: m.index + 23657228, k: m[0] });
for (const h of hits.slice(0, 40)) console.log(`  ${h.off}  ${h.k}`);
