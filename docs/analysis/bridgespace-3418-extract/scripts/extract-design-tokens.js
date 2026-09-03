#!/usr/bin/env node
/** Extract design tokens from carved BridgeSpace CSS files. */
const fs = require("fs");
const path = require("path");

const FRONTEND = path.join(__dirname, "..", "frontend");
const files = fs.readdirSync(FRONTEND).filter((f) => f.endsWith(".css"));
const all = files.map((f) => fs.readFileSync(path.join(FRONTEND, f), "utf8")).join("\n");

// CSS custom properties
const vars = new Map();
const varRe = /(--[\w-]+)\s*:\s*([^;}{]+)/g;
let m;
while ((m = varRe.exec(all)) !== null) {
  const name = m[1];
  const value = m[2].trim().replace(/\s+/g, " ");
  if (!vars.has(name)) vars.set(name, value);
}

// hex colors with frequency
const hexCount = new Map();
const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
while ((m = hexRe.exec(all)) !== null) {
  const c = m[0].toLowerCase();
  hexCount.set(c, (hexCount.get(c) || 0) + 1);
}

// rgb/rgba colors (normalized)
const rgbCount = new Map();
const rgbRe = /rgba?\([^)]+\)/g;
while ((m = rgbRe.exec(all)) !== null) {
  const c = m[0].replace(/\s+/g, "");
  rgbCount.set(c, (rgbCount.get(c) || 0) + 1);
}

// font families
const fonts = new Set();
const fontRe = /font-family\s*:\s*([^;}{]+)/g;
while ((m = fontRe.exec(all)) !== null) {
  fonts.add(m[1].trim().replace(/\s+/g, " "));
}

// border radii
const radii = new Map();
const radiusRe = /border-radius\s*:\s*([^;}{]+)/g;
while ((m = radiusRe.exec(all)) !== null) {
  const v = m[1].trim();
  radii.set(v, (radii.get(v) || 0) + 1);
}

// box shadows
const shadows = new Set();
const shadowRe = /box-shadow\s*:\s*([^;}{]+)/g;
while ((m = shadowRe.exec(all)) !== null) {
  shadows.add(m[1].trim().replace(/\s+/g, " "));
}

// transitions / cubic beziers
const beziers = new Map();
const bezRe = /cubic-bezier\([^)]+\)/g;
while ((m = bezRe.exec(all)) !== null) {
  beziers.set(m[0], (beziers.get(m[0]) || 0) + 1);
}

// font sizes used in px
const fontSizes = new Map();
const fsRe = /font-size\s*:\s*([\d.]+)px/g;
while ((m = fsRe.exec(all)) !== null) {
  fontSizes.set(m[1] + "px", (fontSizes.get(m[1] + "px") || 0) + 1);
}

// spacing/padding common values
const gaps = new Map();
const gapRe = /gap\s*:\s*([\d.]+)px/g;
while ((m = gapRe.exec(all)) !== null) {
  gaps.set(m[1] + "px", (gaps.get(m[1] + "px") || 0) + 1);
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const out = [];
out.push("# Design Tokens — BridgeSpace 3.4.18 (extraído do CSS embutido)\n");
out.push(`Fonte: ${files.length} arquivos CSS carved do binário Tauri.\n`);
out.push("\n## Cores (hex) mais usadas\n");
for (const [c, n] of top(hexCount, 30)) out.push(`- \`${c}\` — ${n}x`);
out.push("\n## Cores (rgb/rgba) mais usadas\n");
for (const [c, n] of top(rgbCount, 30)) out.push(`- \`${c}\` — ${n}x`);
out.push("\n## CSS custom properties\n");
for (const [name, value] of [...vars.entries()].sort()) out.push(`- \`${name}: ${value}\``);
out.push("\n## Fontes\n");
for (const f of [...fonts].sort()) out.push(`- \`${f}\``);
out.push("\n## Border-radius (frequência)\n");
for (const [v, n] of top(radii, 20)) out.push(`- \`${v}\` — ${n}x`);
out.push("\n## Box-shadows (exemplos únicos)\n");
for (const s of [...shadows].sort()) out.push(`- \`${s}\``);
out.push("\n## Cubic-beziers (easing)\n");
for (const [b, n] of top(beziers, 20)) out.push(`- \`${b}\` — ${n}x`);
out.push("\n## Font-size px (frequência)\n");
for (const [v, n] of top(fontSizes, 20)) out.push(`- \`${v}\` — ${n}x`);
out.push("\n## Gap px (frequência)\n");
for (const [v, n] of top(gaps, 20)) out.push(`- \`${v}\` — ${n}x`);

const dest = path.join(__dirname, "..", "DESIGN-TOKENS.md");
fs.writeFileSync(dest, out.join("\n") + "\n");
console.log(`written ${dest}`);
console.log(`css files: ${files.length}, vars: ${vars.size}, hex: ${hexCount.size}, rgb: ${rgbCount.size}, fonts: ${fonts.size}, radii: ${radii.size}, shadows: ${shadows.size}, beziers: ${beziers.size}`);
