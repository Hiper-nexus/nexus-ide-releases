#!/usr/bin/env node
/** Inspect index.html / favicon / duplicate keys in the binary. */
const fs = require("fs");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

function occurrences(pat) {
  const re = new RegExp(pat, "g");
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) out.push(m.index);
  return out;
}

for (const p of ["/index\\.html", "favicon", "index\\.html"]) {
  const offs = occurrences(p);
  console.log(`${p}: ${offs.length} occurrences at ${offs.slice(0, 20).join(", ")}`);
}

// duplicates of asset keys
const re = /\/assets\/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?|ttf|wasm)/g;
const map = new Map();
let m;
while ((m = re.exec(s)) !== null) {
  if (!map.has(m[0])) map.set(m[0], []);
  map.get(m[0]).push(m.index);
}
console.log("\nduplicate asset keys:");
for (const [k, offs] of map) {
  if (offs.length > 1) console.log(`  ${k}: ${offs.join(", ")}`);
}

// dump context around each /index.html occurrence
for (const off of occurrences("/index\\.html")) {
  const pre = bin.subarray(Math.max(0, off - 32), off);
  const post = bin.subarray(off, off + 96);
  console.log(`\n=== /index.html @ ${off} ===`);
  console.log("pre :", JSON.stringify(pre.toString("latin1")));
  console.log("post:", JSON.stringify(post.toString("latin1")));
}
