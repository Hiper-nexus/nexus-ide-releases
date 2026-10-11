import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

import forgeConfig from '../../../forge.config';
import { resolveTesseractWorkerPath } from './ocr';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nodeModules = path.join(repoRoot, 'node_modules');
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
// The exact matcher @electron/asar uses to decide what leaves the archive.
const asarMinimatch = createRequire(requireFromRepo.resolve('@electron/asar'))(
  'minimatch',
) as (file: string, pattern: string, options: { matchBase: boolean }) => boolean;

let scratch = '';

afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function installedPackage(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`dependency not installed: ${name}`);
  }
}

/** tesseract.js plus every package its `dependencies` can reach at runtime. */
function runtimeClosure(name: string): string[] {
  const seen = new Set<string>();
  const visit = (fromDir: string, dependency: string) => {
    const dir = installedPackage(fromDir, dependency);
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const next of Object.keys(manifest.dependencies ?? {})) visit(dir, next);
  };
  visit(repoRoot, name);
  return [...seen];
}

function* filesUnder(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Builds `Resources/app.asar.unpacked/node_modules` the way packaging does:
 * a file lands there only when the forge `asar.unpack` glob matches it. What
 * stays inside app.asar is unreachable from a script running in the unpacked
 * tree, because Node module lookup never walks into the archive.
 */
function emulateUnpackedNodeModules(unpack: string, packages: readonly string[]): string {
  const unpacked = path.join(scratch, 'Resources', 'app.asar.unpacked', 'node_modules');
  for (const dir of packages) {
    for (const file of filesUnder(dir)) {
      const relative = path.relative(nodeModules, file).split(path.sep).join('/');
      // Packager stages the app as `.../Resources/app/node_modules/...`.
      if (!asarMinimatch(`/app/node_modules/${relative}`, unpack, { matchBase: true })) continue;
      const target = path.join(unpacked, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target, fs.constants.COPYFILE_FICLONE);
    }
  }
  return unpacked;
}

describe('OCR worker in the packaged app', () => {
  it('F-1208: o worker do tesseract carrega e inicia o core a partir do app.asar.unpacked', async () => {
    const unpack = (forgeConfig.packagerConfig?.asar as { unpack: string }).unpack;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-packaged-ocr-'));
    const unpacked = emulateUnpackedNodeModules(unpack, runtimeClosure('tesseract.js'));
    // ocr.ts troca app.asar por app.asar.unpacked no caminho do worker.
    const workerEntry = path.join(
      unpacked,
      path.relative(nodeModules, fs.realpathSync(resolveTesseractWorkerPath())),
    );

    const worker = new Worker(workerEntry);
    try {
      const loaded = new Promise<unknown>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`OCR worker exited with ${code}`)));
        worker.on('message', (message: { action?: string; status?: string; data?: unknown }) => {
          if (message.status === 'reject') reject(new Error(String(message.data)));
          if (message.action === 'load' && message.status === 'resolve') resolve(message.data);
        });
      });
      worker.postMessage({
        workerId: 'packaged-ocr',
        jobId: 'load',
        action: 'load',
        payload: { options: { lstmOnly: 1, corePath: '', logging: false } },
      });
      await expect(loaded).resolves.toEqual({ loaded: true });
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});
