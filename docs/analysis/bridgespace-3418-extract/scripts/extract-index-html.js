#!/usr/bin/env node
/** Extract plaintext index.html (Rust include_str! constant) from the binary. */
const fs = require("fs");
const path = require("path");
const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const OUT = path.join(__dirname, "..", "frontend");
const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const marker = '<!DOCTYPE html><html lang="en">';
const start = s.indexOf(marker);
console.log("DOCTYPE html lang=en at:", start);

// Find the end: </html> followed by closing quote or null
let end = s.indexOf("</html>", start);
console.log("</html> at:", end);
if (end < 0) { console.log("no </html> found"); process.exit(1); }
end += "</html>".length;
// include trailing quote if present
if (s[end] === '"') end++;

const html = s.slice(start, end);
console.log("html length:", html.length);
fs.writeFileSync(path.join(OUT, "index.html"), Buffer.from(html, "latin1"));
console.log("written frontend/index.html");

// print head and tail
console.log("HEAD:", JSON.stringify(html.slice(0, 300)));
console.log("TAIL:", JSON.stringify(html.slice(-400)));
