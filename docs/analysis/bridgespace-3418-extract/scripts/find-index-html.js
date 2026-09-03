#!/usr/bin/env node
/** Find the real embedded index.html in the binary. */
const fs = require("fs");
const zlib = require("zlib");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const markers = [
  /<script[^>]*type="module"[^>]*src="\/assets\//g,
  /<div id="root">/g,
  /<!doctype html>/gi,
  /<link rel="stylesheet"[^>]*\/assets\//g,
  /<title>/gi,
];
for (const re of markers) {
  let m;
  const offs = [];
  while ((m = re.exec(s)) !== null) offs.push(m.index);
  console.log(`${re.source}: ${offs.length} at ${offs.slice(0, 10).join(", ")}`);
}

// Look for "<script type=\"module\" crossorigin src=\"/assets/index-" pattern
const idx = s.indexOf('<script type="module" crossorigin src="/assets/index-');
console.log("\nmodule script idx:", idx);
if (idx >= 0) {
  console.log("context:", JSON.stringify(s.slice(idx - 200, idx + 300)));
}
