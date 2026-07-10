#!/usr/bin/env node
/**
 * Launcher do dev flow. Antes de subir o electron-forge, garante que o Electron
 * de dev tenha uma IDENTIDADE TCC própria e estável (com.nexuside.dev) — imune
 * ao rms:0 silencioso causado pelo bundle id compartilhado com.github.Electron
 * (ver scripts/dev-electron-identity.mjs). Aponta o forge para esse app via
 * ELECTRON_OVERRIDE_DIST_PATH, isola userData do app instalado e garante que
 * módulos nativos estejam na ABI do Electron durante a sessão.
 *
 * Fora do macOS (ou se a identidade não puder ser gerada) cai no Electron padrão
 * — o dev flow nunca quebra por causa disto.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevElectronIdentity } from './dev-electron-identity.mjs';
import {
  createDevEnvironment,
  runDevNativeLifecycle,
} from './dev-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = createDevEnvironment(process.env, repoRoot);
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

console.log(`[dev-start] userData isolado: ${env.NEXUS_USER_DATA_DIR}`);

const forgeBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-forge.cmd' : 'electron-forge',
);
const handledSignals = ['SIGINT', 'SIGTERM'];
const signalHandlers = new Map(
  handledSignals.map((signal) => [signal, () => handleSignal(signal)]),
);
let activeChild = null;
let requestedSignal = null;

function handleSignal(signal) {
  requestedSignal ??= signal;
  if (activeChild && !activeChild.killed) activeChild.kill(signal);
}

for (const signal of handledSignals) {
  process.on(signal, signalHandlers.get(signal));
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      cwd: repoRoot,
    });
    activeChild = child;

    const clearActiveChild = () => {
      if (activeChild === child) activeChild = null;
    };
    child.once('error', (error) => {
      clearActiveChild();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearActiveChild();
      resolve({ code: code ?? 1, signal });
    });
  });
}

function npmInvocation(script) {
  if (env.npm_execpath) {
    return {
      command: process.execPath,
      args: [env.npm_execpath, 'run', script],
    };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', script],
  };
}

async function runNpmScript(script) {
  const invocation = npmInvocation(script);
  const result = await runChild(invocation.command, invocation.args);
  if (result.signal || result.code !== 0) {
    throw new Error(
      `${script} falhou${result.signal ? ` com ${result.signal}` : ` (exit ${result.code})`}`,
    );
  }
}

let result;
let failure;
try {
  result = await runDevNativeLifecycle({
    rebuildElectron: async () => {
      console.log('[dev-start] preparando módulos nativos para Electron…');
      await runNpmScript('rebuild:electron');
    },
    startForge: () =>
      runChild(forgeBin, ['start', ...process.argv.slice(2)]),
    rebuildNode: async () => {
      console.log('[dev-start] restaurando módulos nativos para Node…');
      await runNpmScript('rebuild:node');
    },
    onRestoreError: (error) => {
      console.error(
        `[dev-start] falha adicional ao restaurar ABI Node: ${error instanceof Error ? error.message : error}`,
      );
    },
  });
} catch (error) {
  failure = error;
} finally {
  for (const signal of handledSignals) {
    process.off(signal, signalHandlers.get(signal));
  }
}

const finalSignal = requestedSignal ?? result?.signal;
if (finalSignal) {
  process.kill(process.pid, finalSignal);
} else if (failure) {
  console.error(
    `[dev-start] falhou: ${failure instanceof Error ? failure.message : failure}`,
  );
  process.exit(1);
} else {
  process.exit(result?.code ?? 0);
}
