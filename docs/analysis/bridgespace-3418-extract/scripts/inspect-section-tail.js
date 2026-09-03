#!/usr/bin/env node
/** Find last asset key and inspect the section tail. */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const re = /\/assets\/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?|ttf|wasm)/g;
const entries = [];
let m;
while ((m = re.exec(s)) !== null) entries.push({ key: m[0], start: m.index, end: m.index + m[0].length });
entries.sort((a, b) => a.start - b.start);
console.log("first:", entries[0]);
console.log("last :", entries[entries.length - 1]);
const last = entries[entries.length - 1];
// dump after last key
console.log("\n=== after last key (up to 300 bytes) ===");
console.log(JSON.stringify(s.slice(last.end, last.end + 300)));
console.log("\n=== bytes before first key (last 64) ===");
console.log(JSON.stringify(s.slice(entries[0].start - 64, entries[0].start)));

// try brotli after last key with growing length
console.log("\n=== brotli after last key ===");
for (let len = 64; len <= 200000; len *= 2) {
  try {
    const out = zlib.brotliDecompressSync(bin.subarray(last.end, last.end + len));
    console.log(`len=${len} OK out=${out.length} head=${JSON.stringify(out.subarray(0, 60).toString("utf8"))}`);
  } catch (e) {
    console.log(`len=${len} fail`);
  }
}
