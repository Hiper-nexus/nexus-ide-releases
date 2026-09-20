#!/usr/bin/env node
/**
 * Rasteriza os logos de provedor do Redline para o companion de menu bar.
 *
 * AppKit/CoreSVG NÃO renderiza esses SVGs direito (medido: gemini-color.svg
 * vira 14 pixels opacos em 1024), então a rasterização passa pelo Chromium do
 * Electron (devDependency) uma única vez, gerando PNGs 48×48 com alfa em
 * `native/menubar-redline/assets/provider-logos/` + manifest.json
 * (adapterId -> { file, mono }) derivado de PROVIDER_LOGOS em
 * `src/renderer/components/ProviderLogo.tsx`.
 *
 * Roda manualmente (`node scripts/build-redline-logos.mjs`) quando os SVGs
 * mudam — NÃO entra no build do companion; os PNGs são commitados.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const providerLogoSource = path.join(root, "src", "renderer", "components", "ProviderLogo.tsx");
const svgDir = path.join(root, "src", "renderer", "assets", "provider-logos");
const outDir = path.join(root, "native", "menubar-redline", "assets", "provider-logos");

/** adapterId -> { file: <nome do PNG>, mono } — falha alto se o mapa não parsear. */
export function parseProviderLogos(tsx) {
  const imports = new Map();
  for (const match of tsx.matchAll(
    /import (\w+) from '\.\.\/assets\/provider-logos\/([^']+)';/g,
  )) {
    imports.set(match[1], match[2]);
  }
  const manifest = {};
  for (const match of tsx.matchAll(
    /^\s*'?([A-Za-z0-9-]+)'?:\s*\{\s*src:\s*(\w+)(?:\s*,\s*mono:\s*(true|false))?\s*\}/gm,
  )) {
    const [, adapterId, alias, mono] = match;
    const source = imports.get(alias);
    if (!source) {
      throw new Error(`PROVIDER_LOGOS['${adapterId}'] usa import desconhecido '${alias}'`);
    }
    manifest[adapterId] = {
      file: source.replace(/\.svg$/i, ".png"),
      mono: mono === "true",
      source,
    };
  }
  if (Object.keys(manifest).length === 0 || imports.size === 0) {
    throw new Error("não consegui parsear PROVIDER_LOGOS — manifest parcial nunca é emitido");
  }
  return manifest;
}

/**
 * Main-script do Electron que rasteriza cada arquivo para PNG 48×48 numa
 * página transparente e mede a cobertura de pixels opacos — a guarda que pega
 * o caso gemini-color (SVG que renderiza quase em branco).
 */
function electronMain(files, srcDir, destDir, workDir) {
  return `
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

const files = ${JSON.stringify(files)};
const srcDir = ${JSON.stringify(srcDir)};
const destDir = ${JSON.stringify(destDir)};
const workDir = ${JSON.stringify(workDir)};

function fail(message) {
  console.error('FAIL: ' + message);
  process.exit(1);
}

// Sem isso o app sai ao fechar a primeira janela e todo loadFile seguinte
// morre com ERR_FAILED.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const results = [];
  for (const file of files) {
    const win = new BrowserWindow({
      show: false, width: 48, height: 48,
      transparent: true, backgroundColor: '#00000000',
      webPreferences: { sandbox: true },
    });
    try {
      // loadURL(data:) é recusado e data: não carrega file:// como
      // subrecurso: página file:// temporária com o asset embutido inline.
      const raw = readFileSync(path.join(srcDir, file));
      const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      const src = 'data:' + mime + ';base64,' + raw.toString('base64');
      const page = path.join(workDir, 'rasterize.html');
      writeFileSync(page, '<body style="margin:0;background:transparent">'
        + '<img src="' + src + '" width="48" height="48"></body>');
      await win.loadFile(page);
      // capturePage assa um fundo branco mesmo com a janela transparente —
      // o alfa real só existe num canvas desenhado na página.
      const result = await win.webContents.executeJavaScript(\`(async () => {
        const img = document.querySelector('img');
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 48; canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 12) opaque += 1;
        }
        return { png: canvas.toDataURL('image/png'), coverage: opaque / 2304 };
      })()\`);
      if (!result.png.startsWith('data:image/png')) {
        fail(file + ' não produziu PNG no canvas');
      }
      if (result.coverage < 0.05) {
        fail(file + ' rasterizou quase em branco ('
          + (result.coverage * 100).toFixed(2) + '% de pixels opacos)');
      }
      const out = file.replace(/\\.svg$/i, '.png');
      writeFileSync(path.join(destDir, out), Buffer.from(result.png.split(',')[1], 'base64'));
      results.push(file + ' ' + (result.coverage * 100).toFixed(1) + '%');
    } finally {
      win.destroy();
    }
  }
  for (const line of results) console.log('[logo]', line);
  app.exit(0);
}).catch((error) => fail(String(error && error.stack ? error.stack : error)));
`;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tsx = readFileSync(providerLogoSource, "utf8");
  const manifest = parseProviderLogos(tsx);

  // Arquivos únicos, ordenados: saída determinística.
  const files = [...new Set(Object.values(manifest).map((entry) => entry.source))].sort();
  mkdirSync(outDir, { recursive: true });

  const staging = mkdtempSync(path.join(os.tmpdir(), "redline-logos-"));
  const mainScript = path.join(staging, "main.js");
  try {
    writeFileSync(mainScript, electronMain(files, svgDir, outDir, staging));
    const electronBinary = (await import("electron")).default;
    execFileSync(electronBinary, [mainScript], { cwd: root, stdio: "inherit" });
    // O main-script falha alto, mas um PNG ausente aqui é igualmente fatal:
    // o manifest nunca pode apontar para um arquivo que não existe.
    for (const file of files) {
      const out = path.join(outDir, file.replace(/\.svg$/i, ".png"));
      if (!existsSync(out)) {
        throw new Error(`rasterização não produziu ${out}`);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const manifestOut = {};
  for (const adapterId of Object.keys(manifest).sort()) {
    manifestOut[adapterId] = { file: manifest[adapterId].file, mono: manifest[adapterId].mono };
  }
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifestOut, null, 2) + "\n");
  console.log(`[redline] ${files.length} logos rasterizados em ${outDir}`);
}
