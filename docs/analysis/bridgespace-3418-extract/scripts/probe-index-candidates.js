#!/usr/bin/env node
/** Inspect /index.html occurrences near 23957157 (candidate asset map entry). */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

for (const off of [23957157, 24993338]) {
  console.log(`\n=== /index.html @ ${off} ===`);
  console.log("pre :", JSON.stringify(s.slice(off - 100, off)));
  console.log("post:", JSON.stringify(s.slice(off, off + 400)));

  // try brotli after the key + some offset
  for (const skip of [0, 1, 2, 4, 8, 12, 13, 14, 16]) {
    try {
      const out = zlib.brotliDecompressSync(bin.subarray(off + "/index.html".length + skip, off + "/index.html".length + skip + 20000));
      console.log(`  brotli skip=${skip} OK len=${out.length} head=${JSON.stringify(out.subarray(0, 60).toString("utf8"))}`);
    } catch (e) {
      // console.log(`  skip=${skip} fail ${e.message.slice(0, 40)}`);
    }
  }
}
