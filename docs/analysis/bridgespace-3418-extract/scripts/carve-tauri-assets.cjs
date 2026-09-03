#!/usr/bin/env node
// Carve Tauri embedded assets from the BridgeSpace binary.
// Layout discovered: [16-byte asset key hash][path string][brotli-compressed content]
// For every asset path string found in the binary, brotli-decompress starting
// right at the end of the path; on success, write the carved file.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const OUT = process.argv[2] || path.join(__dirname, "..", "frontend");

const buf = fs.readFileSync(BIN);

// Candidate path strings: /assets/* plus bare entry points (index.html etc.)
const PATH_RE = /\/assets\/[A-Za-z0-9_.\-~]+/g;

function* findAll(haystack, needle) {
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    yield i;
    i += needle.length;
  }
}

function looksPlausible(out, name) {
  if (out.length < 8) return false;
  const ext = name.split(".").pop().toLowerCase();
  const head = out.subarray(0, 16).toString("latin1");
  if (ext === "png") return head.startsWith("\x89PNG");
  if (ext === "jpg" || ext === "jpeg") return head.startsWith("\xFF\xD8\xFF");
  if (ext === "ico") return head.startsWith("\x00\x00\x01\x00");
  if (ext === "woff2") return head.startsWith("wOF2");
  if (ext === "woff") return head.startsWith("wOFF");
  if (ext === "ttf") return head.startsWith("\x00\x01\x00\x00");
  if (ext === "svg") return out.subarray(0, 256).toString("utf8").includes("<");
  if (ext === "html") return out.subarray(0, 512).toString("utf8").toLowerCase().includes("<!doctype") || out.subarray(0, 512).toString("utf8").toLowerCase().includes("<html");
  // js/css/json/text: mostly printable
  const sample = out.subarray(0, Math.min(out.length, 4096));
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  return printable / sample.length > 0.98;
}

const seen = new Map(); // path -> carved info
const text = buf.toString("latin1");
const candidates = new Set();
for (const m of text.matchAll(PATH_RE)) {
  if (m[0].startsWith("//")) continue;
  candidates.add(m[0]);
}

console.log(`candidate paths: ${candidates.size}`);
fs.mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const rel of candidates) {
  const needle = Buffer.from(rel, "latin1");
  let carved = false;
  for (const off of findAll(buf, needle)) {
    const start = off + needle.length;
    let out;
    try {
      out = zlib.brotliDecompressSync(buf.subarray(start, Math.min(buf.length, start + 64 * 1024 * 1024)));
    } catch {
      continue;
    }
    const name = rel.replace(/^\//, "").replace(/\//g, "__");
    if (!looksPlausible(out, name)) continue;
    const hash = crypto.createHash("sha256").update(out).digest("hex").slice(0, 12);
    const dest = path.join(OUT, name);
    fs.writeFileSync(dest, out);
    manifest.push({ path: rel, file: name, bytes: out.length, sha256_12: hash });
    carved = true;
    break;
  }
  if (!carved) manifest.push({ path: rel, file: null, note: "not carved" });
}

manifest.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

// Entry HTML is embedded uncompressed: carve every plausible <!DOCTYPE html>...</html> doc.
{
  const needle = Buffer.from("<!DOCTYPE html", "utf8");
  const closers = Buffer.from("</html>", "utf8");
  let i = 0, n = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) {
    const endOff = buf.indexOf(closers, i);
    if (endOff !== -1 && endOff - i < 2 * 1024 * 1024) {
      const html = buf.subarray(i, endOff + 7);
      const head = html.subarray(0, 2048).toString("utf8");
      if (/^<!DOCTYPE html[^>]*>\s*(<!--[\s\S]*?-->\s*)*<html[\s>]/.test(head) && head.includes("<head")) {
        const name = n === 0 ? "index.html" : `index-${n}.html`;
        fs.writeFileSync(path.join(OUT, name), html);
        manifest.push({ path: "/" + name, file: name, bytes: html.length });
        console.log(`carved ${name} (${html.length} B) at offset ${i}: ${head.slice(0, 100).replace(/\n/g, " ")}`);
        n++;
      }
    }
    i += needle.length;
  }
}
const ok = manifest.filter((m) => m.file).length;
console.log(`carved ${ok}/${manifest.length}`);
for (const m of manifest) console.log(m.file ? `  OK ${m.path} (${m.bytes} B)` : `  MISS ${m.path}`);
