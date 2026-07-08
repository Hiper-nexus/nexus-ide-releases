#!/usr/bin/env node
/**
 * Launcher do dev flow. Antes de subir o electron-forge, garante que o Electron
 * de dev tenha uma IDENTIDADE TCC própria e estável (com.nexuside.dev) — imune
 * ao rms:0 silencioso causado pelo bundle id compartilhado com.github.Electron
 * (ver scripts/dev-electron-identity.mjs). Aponta o forge para esse app via
 * ELECTRON_OVERRIDE_DIST_PATH e repassa stdio/sinais.
 *
 * Fora do macOS (ou se a identidade não puder ser gerada) cai no Electron padrão
 * — o dev flow nunca quebra por causa disto.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevElectronIdentity } from './dev-electron-identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
try {
  const identity = ensureDevElectronIdentity({ log: (m) => console.log(m) });
  if (identity) {
    env.ELECTRON_OVERRIDE_DIST_PATH = identity.distPath;
    console.log(`[dev-start] identidade TCC: ${identity.bundleId} → ${identity.distPath}`);
  }
} catch (err) {
  console.warn(
    `[dev-start] identidade dev falhou (${err instanceof Error ? err.message : err}) — usando Electron padrão`,
  );
}

const forgeBin = path.join(repoRoot, 'node_modules', '.bin', 'electron-forge');
const child = spawn(forgeBin, ['start', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: repoRoot,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
