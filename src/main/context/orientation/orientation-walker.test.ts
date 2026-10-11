// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_ORIENTATION_LIMITS } from './orientation-types';
import { walkOrientationTreeAsync } from './orientation-walker';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

it('não gasta o orçamento de bytes com arquivos que nunca lê', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-walk-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/shot.png'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(root, 'src/main/updater.ts'), 'export const x = 1;\n');
  const scope = Object.freeze({ version: 1, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: root, identitySource: 'provisional' as const });
  const walk = await walkOrientationTreeAsync(scope, { ...DEFAULT_ORIENTATION_LIMITS, maxTotalBytes: 1024 });
  expect(walk.truncated).toBe(false);
  expect(walk.files.map((f) => f.relativePath)).toContain('src/main/updater.ts');
});
