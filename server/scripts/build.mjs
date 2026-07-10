import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(serverRoot, 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await build({
  entryPoints: [resolve(serverRoot, 'src', 'index.ts')],
  outfile: resolve(outputDirectory, 'index.js'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
