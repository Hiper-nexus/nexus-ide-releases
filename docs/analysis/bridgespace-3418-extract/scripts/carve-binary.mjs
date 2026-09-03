#!/usr/bin/env node
/**
 * carve-binary.mjs — extrai assets frontend embutidos no binário Tauri do BridgeSpace.
 *
 * Estratégia: varre o binário atrás de (a) runs de texto imprimível longos (HTML/JS/CSS/SVG/JSON)
 * e (b) assets binários por magic bytes (PNG/JPEG/WOFF/WOFF2). Classifica, deduplica e salva
 * cada asset com offset+size registrados em inventory.json.
 *
 * Uso: node carve-binary.mjs <caminho-do-binario> <dir-de-saida>
 * Zero dependências — Node puro.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [binPathArg, outDirArg] = process.argv.slice(2);
const BIN = binPathArg ?? '/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri';
const OUT = outDirArg ?? path.join(import.meta.dirname, '..', 'frontend');
const STAGE = path.join(OUT, '_carved');

fs.mkdirSync(STAGE, { recursive: true });
const buf = fs.readFileSync(BIN);
console.log(`binário: ${BIN} (${buf.length} bytes)`);

const inventory = [];

// ---------- util ----------
const isPrintable = (b) =>
  (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d;

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function classifyText(s) {
  const head = s.slice(0, 200).trimStart();
  if (/^<!DOCTYPE html/i.test(head) || /^<html/i.test(head)) return 'html';
  if (/^<svg/i.test(head) || /^<\?xml/i.test(head)) return 'svg';
  if (/^\/\*/.test(head) && /\}\s*$/.test(s) && (s.match(/[:;]/g) ?? []).length > 30) return 'css';
  // CSS puro: chaves+dois-pontos dominantes, sem arrow fn / function
  const cssish = (s.match(/[{}]/g) ?? []).length;
  const jsish = (s.match(/=>|function\s*\(|\bconst\s+\w|import\s*\(/g) ?? []).length;
  if (cssish > 10 && jsish < 2 && (s.match(/:/g) ?? []).length > 10) return 'css';
  if (jsish >= 2 || /^import\s/m.test(s) || /^!function/m.test(s) || /^self\./m.test(s)) return 'js';
  if (/^\{/.test(head) || /^\[/.test(head)) {
    try { JSON.parse(s); return 'json'; } catch { /* nem todo JSON gigante é válido aqui */ }
  }
  return 'text';
}

// ---------- 1. runs de texto imprimível ----------
const runs = [];
let start = -1;
for (let i = 0; i < buf.length; i++) {
  if (isPrintable(buf[i])) {
    if (start === -1) start = i;
  } else {
    if (start !== -1) {
      const len = i - start;
      if (len >= 512) runs.push([start, len]);
      start = -1;
    }
  }
}
if (start !== -1 && buf.length - start >= 512) runs.push([start, buf.length - start]);
console.log(`runs de texto >=512 bytes: ${runs.length}`);

// ---------- 2. assets binários por magic ----------
function carveBinary() {
  const found = [];
  const magics = [
    { name: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: 'jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    { name: 'woff', bytes: Buffer.from('wOFF') },
    { name: 'woff2', bytes: Buffer.from('wOF2') },
  ];
  for (const m of magics) {
    let pos = 0;
    for (;;) {
      const at = buf.indexOf(m.bytes, pos);
      if (at === -1) break;
      pos = at + 1;
      let size = 0;
      if (m.name === 'png') {
        const iend = buf.indexOf(Buffer.from('IEND'), at);
        size = iend === -1 ? 0 : iend + 8 - at;
      } else if (m.name === 'jpeg') {
        let p = at + 3;
        // varre marcadores até EOI (ffd9) ou limite
        while (p < buf.length - 1) {
          if (buf[p] === 0xff && buf[p + 1] === 0xd9) { size = p + 2 - at; break; }
          if (buf[p] === 0xff && buf[p + 1] === 0xda) {
            // scan de dados até próximo marcador não-RST
            p += 2;
            while (p < buf.length - 1 && !(buf[p] === 0xff && buf[p + 1] !== 0x00 && !(buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7))) p++;
            continue;
          }
          if (buf[p] === 0xff) { p += 2; const segLen = buf.readUInt16BE(p); p += segLen; continue; }
          p++;
        }
      } else if (m.name === 'woff' || m.name === 'woff2') {
        size = buf.readUInt32BE(at + 4); // campo length total do container
      }
      if (size > 0 && size < 20_000_000) found.push({ type: m.name, offset: at, size });
    }
  }
  return found;
}

// ---------- classificação + gravação ----------
const seen = new Set();
function save(type, data, offset, extra = {}) {
  const h = sha(data);
  if (seen.has(h)) {
    const prev = inventory.find((i) => i.sha16 === h);
    prev.dups = (prev.dups ?? 1) + 1;
    return;
  }
  seen.add(h);
  const fname = `${String(inventory.length + 1).padStart(4, '0')}-${type}-${h}.${type === 'jpeg' ? 'jpg' : type}`;
  fs.writeFileSync(path.join(STAGE, fname), data);
  inventory.push({
    file: fname, type, offset, size: data.length, sha16: h, preview: data.subarray(0, 120).toString('utf8').replace(/\s+/g, ' '), ...extra,
  });
}

for (const [off, len] of runs) {
  const s = buf.toString('latin1', off, off + len);
  const type = classifyText(s);
  if (type === 'text') continue; // ruído
  save(type, Buffer.from(s, 'latin1'), off, { runLen: len });
}

for (const b of carveBinary()) {
  const data = buf.subarray(b.offset, b.offset + b.size);
  if (data.length < 100) continue;
  save(b.type, data, b.offset, { guessedSize: b.size });
}

fs.writeFileSync(path.join(OUT, 'inventory.json'), JSON.stringify(inventory, null, 2));
const byType = {};
for (const i of inventory) byType[i.type] = (byType[i.type] ?? 0) + 1;
console.log('extraído por tipo:', byType);
console.log(`total: ${inventory.length} assets únicos → ${STAGE}`);
console.log('inventory.json gravado');
