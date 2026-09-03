#!/usr/bin/env node
/** Dump the region around the plaintext index.html (doctype at 19191806). */
const fs = require("fs");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const idx = s.indexOf("<!doctype html>");
console.log("doctype idx:", idx);
console.log("=== 400 bytes from doctype ===");
console.log(JSON.stringify(s.slice(idx, idx + 1200)));

// also dump around 19199908 (the /index.html path string)
console.log("\n=== 500 bytes around /index.html @19199908 ===");
console.log(JSON.stringify(s.slice(19199908 - 500, 19199908 + 200)));
