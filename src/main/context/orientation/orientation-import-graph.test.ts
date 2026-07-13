import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import { DEFAULT_ORIENTATION_LIMITS } from './orientation-types';
import { buildOrientationImportGraph } from './orientation-import-graph';
import { walkOrientationTree } from './orientation-walker';
import { computeBlastRadius } from './orientation-blast-radius';
import {
  buildContextBootstrapProposals,
  isAutoReviewableBootstrapProposal,
} from './orientation-bootstrap-context';
import { ProjectOrientationService } from './orientation-service';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-graph',
    projectId: 'project-graph',
    checkoutId: 'checkout-graph',
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

describe('orientation import graph + blast radius + bootstrap (P1–P4)', () => {
  it('builds import edges and expands blast radius', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-igraph-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-igraph-cache-'));
    roots.push(root, cacheRoot);

    write(root, 'package.json', JSON.stringify({ name: 'g', scripts: { test: 'vitest' } }));
    write(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    write(root, 'src/b.ts', "import { c } from './c';\nexport const b = c;\n");
    write(root, 'src/c.ts', 'export const c = 1;\n');
    write(root, '.dev-user-data/cache/generated.ts', 'export const noise = 1;\n');
    write(root, '.dev-electron/dist/generated.js', 'module.exports = {};\n');

    const scope = scopeFor(root);
    const walk = walkOrientationTree(scope, DEFAULT_ORIENTATION_LIMITS);
    expect(walk.files.some((file) => file.relativePath.includes('.dev-user-data'))).toBe(false);
    expect(walk.files.some((file) => file.relativePath.includes('.dev-electron'))).toBe(false);
    const graph = buildOrientationImportGraph(scope, walk, DEFAULT_ORIENTATION_LIMITS);
    expect(graph.graph.edgeCount).toBeGreaterThanOrEqual(2);
    expect(graph.graph.mode).toBe('imports');
    expect(graph.adjacency.get('src/a.ts')).toContain('src/b.ts');

    const service = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const map = await service.ensure(scope, { reason: 'workspace-open' });
    expect(map.graph.edgeCount).toBeGreaterThanOrEqual(2);
    expect(map.graph.adjacency).toBeTruthy();

    const radius = computeBlastRadius(map, {
      seedFiles: ['src/a.ts'],
      depth: 2,
    });
    expect(radius.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('proposes context docs bound to real source hashes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-boot-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-boot-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'package.json', JSON.stringify({ name: 'boot-app', scripts: { test: 'vitest' } }));
    write(root, 'README.md', '# Boot\n');
    write(root, 'PRODUCT.md', '# Product\n\n## Users\nDevelopers using AI CLIs.\n\n## Purpose\nCoordinate agents.\n');
    write(root, 'src/main.ts', 'export function main() {}\n');

    const service = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const map = await service.ensure(scopeFor(root), { reason: 'mcp' });
    const proposals = buildContextBootstrapProposals(scopeFor(root), map);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.sources.length > 0)).toBe(true);
    expect(proposals.some((p) => p.targetPath.includes('architecture'))).toBe(true);
    expect(proposals[0].content).toContain('Auto-proposed');
    const business = proposals.find((proposal) => proposal.targetPath.endsWith('business-model.md'));
    expect(business?.content).toContain('Developers using AI CLIs');
    expect(business?.content).not.toContain('TODO');
    expect(business && isAutoReviewableBootstrapProposal(business)).toBe(true);
  });
});
