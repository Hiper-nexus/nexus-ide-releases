#!/usr/bin/env node
/**
 * BridgeSpace 3.4.18 — full Tauri binary carver.
 *
 * Format discovered: the Mach-O embeds the frontend as a sequence of
 *   [path string][brotli-compressed bytes]
 * where the path is "/assets/<name>-<hash>.<ext>" (or "/index.html") and the
 * compressed data runs until the next path string in the section.
 *
 * Output: frontend/<path minus leading slash>, plus frontend/_manifest.json
 * with byte offsets and sizes for reproducibility.
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const BIN = "/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri";
const OUT = path.join(__dirname, "..", "frontend");

const bin = fs.readFileSync(BIN);
const s = bin.toString("latin1");

const KEY_RE = /\/assets\/[\w\-.]+\.(?:js|css|svg|png|ico|woff2?|ttf|wasm)|\/index\.html|\/favicon\.\w+/g;
const entries = [];
let m;
while ((m = KEY_RE.exec(s)) !== null) {
  entries.push({ key: m[0], start: m.index, end: m.index + m[0].length });
}
entries.sort((a, b) => a.start - b.start);

// de-duplicate (same key may appear once; keep first)
const seen = new Set();
const unique = entries.filter((e) => {
  if (seen.has(e.key)) return false;
  seen.add(e.key);
  return true;
});
console.log(`asset keys found: ${entries.length} (unique ${unique.length})`);

function tryDecompress(buf) {
  try {
    return { ok: true, out: zlib.brotliDecompressSync(buf) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// For the LAST entry the next-key delimiter does not exist. Find the section
// end by scanning forward for a null-ish boundary (>=32 zero bytes) or by
// growing the blob until brotli succeeds.
function findSectionEnd(start) {
  // try up to 16 MiB, but stop early if a long zero run appears (typical
  // __const section padding after the asset blob).
  const MAX = 16 * 1024 * 1024;
  let best = null;
  let zeroRun = 0;
  for (let i = start; i < Math.min(start + MAX, bin.length); i++) {
    if (bin[i] === 0) {
      zeroRun++;
      if (zeroRun >= 32) {
        // candidate end at i - zeroRun + 1
        const end = i - zeroRun + 1;
        const r = tryDecompress(bin.subarray(start, end));
        if (r.ok) return end;
        best = best || end;
      }
    } else {
      zeroRun = 0;
    }
  }
  return best;
}

const results = [];
let failures = 0;

for (let i = 0; i < unique.length; i++) {
  const e = unique[i];
  const dataStart = e.end;
  let dataEnd;
  if (i + 1 < unique.length) {
    dataEnd = unique[i + 1].start;
  } else {
    dataEnd = findSectionEnd(dataStart) || dataStart + 4096;
  }
  let blob = bin.subarray(dataStart, dataEnd);
  let r = tryDecompress(blob);

  // Fallback: the next-key delimiter may be wrong if the compressed stream
  // contains a byte sequence that looks like a key. Scan forward.
  if (!r.ok) {
    const MAXSCAN = 32 * 1024 * 1024;
    for (let end = dataStart + 64; end < Math.min(dataStart + MAXSCAN, bin.length); end += 64) {
      r = tryDecompress(bin.subarray(dataStart, end));
      if (r.ok) {
        blob = bin.subarray(dataStart, end);
        dataEnd = end;
        break;
      }
    }
  }

  if (r.ok) {
    const rel = e.key.replace(/^\//, "");
    const outPath = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, r.out);
    results.push({
      asset: e.key,
      file: rel,
      keyOffset: e.start,
      dataOffset: dataStart,
      dataEnd,
      compressedBytes: dataEnd - dataStart,
      decompressedBytes: r.out.length,
    });
    if (results.length <= 12) {
      console.log(
        `OK   ${e.key}  ${dataEnd - dataStart}B -> ${r.out.length}B`
      );
    }
  } else {
    failures++;
    console.log(`FAIL ${e.key}  err=${r.err}`);
    results.push({
      asset: e.key,
      keyOffset: e.start,
      dataOffset: dataStart,
      dataEnd,
      compressedBytes: dataEnd - dataStart,
      error: r.err,
    });
  }
}

fs.writeFileSync(
  path.join(OUT, "_manifest.json"),
  JSON.stringify(results, null, 2)
);
const total = results.reduce((a, r) => a + (r.decompressedBytes || 0), 0);
console.log(`\ncarved ${results.length - failures}/${unique.length} assets, ${total} bytes decompressed`);
console.log(`failures: ${failures}`);
