/**
 * electron-rebuild com retry: o node-gyp 10 tem uma corrida interna no
 * cleanup de `build/node_gyp_bins` (ENOENT lstat DEPOIS do SOLINK bem
 * sucedido) que derruba ~metade dos `npm start` (3x em 20/08). O build em si
 * está bom quando o flake ocorre — limpar o diretório e repetir uma vez
 * resolve. Pre-clean continua: rebuild sobre build/ node-ABI também falhava.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const BIN = path.join(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild',
);
const ARGS = [
  '-f',
  '-s',
  '-o',
  '@lydell/node-pty,better-sqlite3,onnxruntime-node',
];
const ATTEMPTS = 2;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  rmSync('node_modules/better-sqlite3/build', { recursive: true, force: true });
  try {
    execFileSync(BIN, ARGS, {
      stdio: 'inherit',
      // .cmd no Windows exige shell desde o fix de CVE do Node; args são
      // constantes deste script, sem superfície de injeção.
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    process.exit(0);
  } catch {
    if (attempt === ATTEMPTS) {
      console.error(
        `[rebuild-electron] falhou ${ATTEMPTS}x — não é o flake, investigue.`,
      );
      process.exit(1);
    }
    console.warn(
      '[rebuild-electron] tentativa falhou (flake node_gyp_bins) — repetindo…',
    );
  }
}
