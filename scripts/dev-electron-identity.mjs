#!/usr/bin/env node
/**
 * DEV MIC TCC FIX. O binário Electron do dev (node_modules/electron) usa o
 * bundle id COMPARTILHADO `com.github.Electron` — o MESMO de todo outro Electron
 * de dev na máquina. O macOS chaveia a permissão de microfone (TCC) por bundle
 * id + assinatura (csreq). Quando outro binário Electron (assinatura diferente)
 * mintou a entrada TCC desse bundle id, o macOS ENTREGA ZEROS (rms:0) em vez de
 * pedir permissão — silenciosamente. Sintoma: wake funciona por um tempo e
 * depois "ensurdece" (frames rms:0) sem erro nem prompt.
 *
 * Correção: dar ao build de dev uma IDENTIDADE TCC PRÓPRIA e ESTÁVEL. Copiamos o
 * Electron.app para um dist local do repo (gitignored), trocamos o
 * CFBundleIdentifier para `com.nexuside.dev`, re-assinamos ad-hoc (csreq estável)
 * e apontamos o dev flow para ele via ELECTRON_OVERRIDE_DIST_PATH. Assim o grant
 * de mic do dev fica imune a qualquer outro Electron da máquina.
 *
 * Idempotente e à prova de bump: um selo grava a versão do Electron + bundle id;
 * se o node_modules/electron mudar de versão (ou a identidade não bater), regenera.
 * No-op fora do macOS (TCC é só Apple).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_BUNDLE_ID = 'com.nexuside.dev';
export const DEV_BUNDLE_NAME = 'NexusIDE Dev';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readElectronVersion() {
  const pkg = path.join(repoRoot, 'node_modules', 'electron', 'package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

function plistSet(infoPlist, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, infoPlist], {
    stdio: 'pipe',
  });
}

/**
 * Garante o Electron.app de dev com identidade TCC própria. Devolve
 * { distPath, bundleId, changed } no macOS, ou null em outras plataformas
 * (o dev flow segue com o Electron padrão do node_modules).
 */
export function ensureDevElectronIdentity({ log = () => {} } = {}) {
  if (process.platform !== 'darwin') return null;

  const srcApp = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!existsSync(srcApp)) {
    log(`[dev-identity] Electron.app não encontrado em ${srcApp} — pulando`);
    return null;
  }
  const version = readElectronVersion();
  const root = path.join(repoRoot, '.dev-electron');
  const distPath = path.join(root, 'dist');
  const app = path.join(distPath, 'Electron.app');
  const stampFile = path.join(root, '.identity.json');
  const infoPlist = path.join(app, 'Contents', 'Info.plist');

  const stamp = existsSync(stampFile)
    ? JSON.parse(readFileSync(stampFile, 'utf8'))
    : null;
  const upToDate =
    stamp?.version === version &&
    stamp?.bundleId === DEV_BUNDLE_ID &&
    existsSync(app) &&
    existsSync(infoPlist);

  if (upToDate) {
    log(`[dev-identity] identidade OK (${DEV_BUNDLE_ID}, electron ${version})`);
    return { distPath, bundleId: DEV_BUNDLE_ID, changed: false };
  }

  log(`[dev-identity] gerando identidade dev (${DEV_BUNDLE_ID}, electron ${version})…`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(distPath, { recursive: true });
  // ditto preserva frameworks, symlinks e permissões do bundle Electron.
  execFileSync('/usr/bin/ditto', [srcApp, app], { stdio: 'pipe' });

  plistSet(infoPlist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
  plistSet(infoPlist, 'CFBundleName', DEV_BUNDLE_NAME);
  // CFBundleDisplayName pode não existir; adiciona se faltar (ignore erro).
  try {
    plistSet(infoPlist, 'CFBundleDisplayName', DEV_BUNDLE_NAME);
  } catch {
    try {
      execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', `Add :CFBundleDisplayName string ${DEV_BUNDLE_NAME}`, infoPlist],
        { stdio: 'pipe' },
      );
    } catch {
      // display name é cosmético — não bloqueia a identidade TCC.
    }
  }

  // Ad-hoc re-sign do bundle inteiro → csreq ESTÁVEL sob o novo bundle id.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app], {
    stdio: 'pipe',
  });

  writeFileSync(
    stampFile,
    `${JSON.stringify({ version, bundleId: DEV_BUNDLE_ID }, null, 2)}\n`,
  );
  log(`[dev-identity] pronto: ${app}`);
  return { distPath, bundleId: DEV_BUNDLE_ID, changed: true };
}

// CLI: `node scripts/dev-electron-identity.mjs` — gera/valida e imprime o dist.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureDevElectronIdentity({ log: (m) => console.log(m) });
  if (result) console.log(result.distPath);
}
