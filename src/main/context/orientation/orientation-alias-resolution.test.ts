import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import { ProjectOrientationService } from './orientation-service';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-alias',
    projectId: 'project-alias',
    checkoutId: 'checkout-alias',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('import graph resolves @/... aliases from the scanned project tsconfig.json', () => {
  it('connects a.ts -> src/util/b.ts through the @/util/b specifier', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-alias-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-alias-cache-'));
    roots.push(root, cacheRoot);

    write(root, 'package.json', JSON.stringify({ name: 'alias-app' }));
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }));
    write(root, 'src/a.ts', "import { b } from '@/util/b';\nexport const a = b;\n");
    write(root, 'src/util/b.ts', 'export const b = 1;\n');

    const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
    const map = await service.ensure(scopeFor(root), { reason: 'workspace-open' });

    expect(map.graph.adjacency?.['src/a.ts']).toContain('src/util/b.ts');
  });
});
