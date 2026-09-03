#!/usr/bin/env node
/** Search backwards from asset section for index.html entry: [path][brotli]. */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const anchor = s.indexOf("/assets/UpdateNotificationModal-as7iX6qL.js");
const WINDOW = 262144; // 256 KB before anchor

// candidate path-like strings before anchor
const re = /\/[\w][\w\-.~]{1,80}/g;
const region = s.slice(anchor - WINDOW, anchor);
const cands = [];
let m;
while ((m = re.exec(region)) !== null) {
  cands.push({ start: m.index, key: m[0] });
}

console.log(`candidates in ${WINDOW}B window: ${cands.length}`);

for (const c of cands) {
  const keyStart = anchor - WINDOW + c.start;
  const dataStart = keyStart + c.key.length;
  if (dataStart >= anchor) continue;
  const blob = bin.subarray(dataStart, anchor);
  if (blob.length < 4) continue;
  try {
    const out = zlib.brotliDecompressSync(blob);
    if (out.length > 100) {
      console.log(`BROTLI OK  key=${JSON.stringify(c.key)}  start=${keyStart}  blob=${blob.length}  out=${out.length}  head=${JSON.stringify(out.subarray(0, 80).toString("utf8"))}`);
    }
  } catch {}
}
console.log("done");
