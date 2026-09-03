#!/usr/bin/env node
const fs = require("fs");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

// region around the first <!doctype html> occurrence at ~19191806
const idx = 19191806;
console.log("=== 19191806 - 600 .. +600 ===");
console.log(JSON.stringify(s.slice(idx - 600, idx + 600)));
console.log("\n=== 19199908 - 300 .. +300 ===");
console.log(JSON.stringify(s.slice(19199908 - 300, 19199908 + 300)));
