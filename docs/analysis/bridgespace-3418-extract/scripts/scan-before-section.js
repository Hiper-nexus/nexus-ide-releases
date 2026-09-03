#!/usr/bin/env node
/** Scan backwards/forwards from asset section to find index.html entry. */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const firstKey = s.indexOf("/assets/UpdateNotificationModal-as7iX6qL.js");
console.log("first asset key at:", firstKey);

// dump 256 bytes before first key
console.log("=== 256 bytes before first key ===");
console.log(JSON.stringify(s.slice(firstKey - 256, firstKey)));

// search backwards for "/index" or "/" + word in this region
const region = s.slice(firstKey - 20000, firstKey);
let m;
const re = /\/[A-Za-z][\w\-.]{1,60}/g;
const hits = [];
while ((m = re.exec(region)) !== null) hits.push({ s: m.index, k: m[0] });
console.log("\ncandidate keys before first asset key (last 20):");
for (const h of hits.slice(-20)) console.log(`  ${firstKey - 20000 + h.s}  ${h.k}`);

// Try to brotli-decompress the bytes right before the first key with various starts
console.log("\n=== try brotli on region before first key ===");
for (let start = firstKey - 3000; start < firstKey; start += 100) {
  try {
    const out = zlib.brotliDecompressSync(bin.subarray(start, firstKey));
    console.log(`OK start=${start} len=${out.length} head=${JSON.stringify(out.subarray(0, 80).toString("utf8"))}`);
  } catch {}
}
