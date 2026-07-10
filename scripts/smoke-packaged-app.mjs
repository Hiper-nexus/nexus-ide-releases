import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 70_000;
const MAX_LOG_CHARS = 32_000;
const PACKAGED_SMOKE_ARGUMENT = 'nexus-smoke-test';

export function packagedBinaryForApp(appPath) {
  if (!appPath.endsWith('.app')) {
    throw new Error(`packaged smoke target must be a .app bundle: ${appPath}`);
  }
  return path.join(appPath, 'Contents', 'MacOS', 'NexusIDE');
}

export function resolveAppArgument(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--app' || !args[1]) {
    throw new Error('usage: smoke-packaged-app.mjs [--app /path/to/NexusIDE.app]');
  }
  return path.resolve(args[1]);
}

/**
 * Electron/Chromium can consume an unknown --switch before application code
 * sees process.argv. Use a positional sentinel for the app mode and a native
 * Chromium profile switch as a second isolation barrier.
 */
export function packagedSmokeArgs(userData) {
  const isolatedUserData = path.resolve(userData);
  return [
    PACKAGED_SMOKE_ARGUMENT,
    `--user-data-dir=${isolatedUserData}`,
  ];
}

/** Keep every filesystem default scoped to the temporary smoke directory. */
export function packagedSmokeEnvironment(baseEnv, userData) {
  const isolatedUserData = path.resolve(userData);
  return {
    ...baseEnv,
    HOME: path.join(isolatedUserData, 'home'),
    NEXUS_USER_DATA_DIR: isolatedUserData,
  };
}

/** Functional smoke creates this file under app.getPath('userData'). */
export function packagedSmokeMarkerPath(userData) {
  return path.join(
    path.resolve(userData),
    'functional-smoke-workspace',
    'smoke.txt',
  );
}

export function assertPackagedSmokeProof(code, output) {
  if (code !== 0) {
    throw new Error(`packaged smoke exited ${String(code)}\n${output}`);
  }
  if (!output.includes('[smoke] renderer-mounted')) {
    throw new Error(`packaged smoke exited without renderer proof\n${output}`);
  }
  if (!output.includes('[smoke] functional-ready')) {
    throw new Error(`packaged smoke exited without functional proof\n${output}`);
  }
}

function defaultPackagedApp() {
  if (process.platform !== 'darwin') {
    throw new Error('packaged smoke currently supports the macOS release target only');
  }
  return path.resolve(
    `out/NexusIDE-darwin-${process.arch}/NexusIDE.app`,
  );
}

export async function runPackagedSmoke(appPath) {
  const binary = packagedBinaryForApp(appPath);
  await fs.access(binary);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-packaged-smoke-'));
  await fs.mkdir(path.join(userData, 'home'), { recursive: true, mode: 0o700 });
  let output = '';

  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(binary, packagedSmokeArgs(userData), {
        env: packagedSmokeEnvironment(process.env, userData),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (chunk) => {
        output = (output + chunk.toString()).slice(-MAX_LOG_CHARS);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', reject);
      child.once('close', resolve);

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`packaged smoke timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      timeout.unref();
      child.once('close', () => clearTimeout(timeout));
    });

    assertPackagedSmokeProof(code, output);
    await fs.access(packagedSmokeMarkerPath(userData));
    process.stdout.write(output);
  } finally {
    await fs.rm(userData, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('packaged smoke currently supports the macOS release target only');
  }
  const explicitApp = resolveAppArgument(process.argv.slice(2));
  await runPackagedSmoke(explicitApp ?? defaultPackagedApp());
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
