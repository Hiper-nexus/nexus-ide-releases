#!/usr/bin/env node
/**
 * scan-brotli.mjs (v2 — walk sequencial) — descomprime os assets brotli embutidos
 * no binário Tauri do BridgeSpace.
 *
 * O tauri-codegen comprime cada asset num stream brotli contíguo. Estratégia:
 * 1. tenta descomprimir no offset atual; se falhar, avança 1 byte;
 * 2. se conseguir, busca binária do menor L que descomprime = tamanho do stream;
 * 3. pula para off+L (próximo asset) — sem varredura por byte na região toda.
 *
 * Uso: node --max-old-space-size=8192 scan-brotli.mjs [binario] [saida]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const BIN = process.argv[2] ?? '/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri';
const OUT = process.argv[3] ?? path.join(import.meta.dirname, '..', 'frontend', '_brotli');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const buf = fs.readFileSync(BIN);
// região de alta entropia medida empiricamente (scan-entropy)
const START = 0x0131a000 - 0x800;
const END = 0x01691000 + 0x800;
const WINDOW = 1 << 20;
const MAXOUT = 48 * 1024 * 1024;

function tryDecompress(off, len) {
  return zlib.brotliDecompressSync(buf.subarray(off, Math.min(off + len, buf.length)), { maxOutputLength: MAXOUT });
}

/** menor L tal que buf[off, off+L) descomprime — busca binária */
function minStreamLen(off, firstOkLen) {
  let lo = 1, hi = firstOkLen;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try { tryDecompress(off, mid); ok = true; } catch { ok = false; }
    if (ok) hi = mid; else lo = mid + 1;
  }
  return lo;
}

const found = [];
let off = START;
const t0 = Date.now();
while (off < END) {
  let out = null;
  try { out = tryDecompress(off, WINDOW); } catch { /* sem stream aqui */ }
  if (out && out.length >= 128) {
    const compLen = minStreamLen(off, WINDOW);
    const h = crypto.createHash('sha256').update(out).digest('hex').slice(0, 16);
    const ext = classify(out);
    const fname = `${String(found.length + 1).padStart(3, '0')}-${h}.${ext}`;
    fs.writeFileSync(path.join(OUT, fname), out);
    found.push({ file: fname, offset: off, compLen, decompLen: out.length, sha16: h, type: ext, head: out.subarray(0, 100).toString('utf8').replace(/\s+/g, ' ') });
    console.log(`+ ${fname} @0x${off.toString(16)} comp=${compLen} decomp=${out.length} (${ext})`);
    off += compLen;
    continue;
  }
  off += 1;
}
console.log(`\nstreams: ${found.length} | tempo: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
fs.writeFileSync(path.join(OUT, '..', 'inventory-brotli.json'), JSON.stringify(found, null, 2));

function classify(data) {
  const s = data.subarray(0, 500).toString('utf8');
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (/^<!DOCTYPE html|^<html/i.test(s.trimStart())) return 'html';
  if (/^<svg/i.test(s.trimStart())) return 'svg';
  if (/^@font-face/.test(s.trimStart()) || (s.includes('{') && s.includes('}') && /\.[-a-z]+\s*\{/.test(s) && !s.includes('=>'))) return 'css';
  if (s.includes('=>') || /function/.test(s) || /^import/.test(s.trimStart())) return 'js';
  if (/^[{[]/.test(s.trimStart())) return 'json';
  return 'txt';
}
