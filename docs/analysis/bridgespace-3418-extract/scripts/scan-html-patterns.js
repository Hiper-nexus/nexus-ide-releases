#!/usr/bin/env node
const fs = require("fs");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const patterns = [
  /<html lang=/gi,
  /<div id="root"/g,
  /src="\/assets/g,
  /href="\/assets/g,
  /<\/body>/gi,
  /<script/g,
  /index-[A-Za-z0-9_-]+\.js/g,
  /crossorigin/g,
];
for (const re of patterns) {
  let m; const offs = [];
  while ((m = re.exec(s)) !== null) offs.push(m.index);
  console.log(`${String(re)}: ${offs.length} at ${offs.slice(0, 15).join(", ")}`);
}
