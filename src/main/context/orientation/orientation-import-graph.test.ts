import { createHash } from 'node:crypto';
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
    write(root, '.claude/worktrees/stale/package.json', '{"name":"stale"}\n');
    write(root, '.codex/cache/generated.ts', 'export const noise = 1;\n');
    write(root, '.context/docs/generated.ts', 'export const noise = 1;\n');
    write(root, '.gemini/cache/generated.ts', 'export const noise = 1;\n');
    write(root, '.overclock-app/panes.json', '{}\n');
    write(root, '.worktrees/old/package.json', '{"name":"old"}\n');
    write(root, '.vite/cache/generated.js', 'module.exports = {};\n');
    write(root, 'graphify-out/generated.ts', 'export const noise = 1;\n');
    write(root, 'release-assets/generated.js', 'module.exports = {};\n');

    const scope = scopeFor(root);
    const walk = walkOrientationTree(scope, DEFAULT_ORIENTATION_LIMITS);
    expect(walk.files.some((file) => file.relativePath.includes('.dev-user-data'))).toBe(false);
    expect(walk.files.some((file) => file.relativePath.includes('.dev-electron'))).toBe(false);
    for (const excluded of [
      '.claude/',
      '.codex/',
      '.context/',
      '.gemini/',
      '.overclock-app/',
      '.worktrees/',
      '.vite/',
      'graphify-out/',
      'release-assets/',
    ]) {
      expect(
        walk.files.some((file) => file.relativePath.startsWith(excluded)),
        `${excluded} leaked into orientation`,
      ).toBe(false);
    }
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
    write(root, 'package.json', JSON.stringify({
      name: 'boot-app',
      scripts: {
        test: 'vitest',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        build: 'vite build',
        dev: 'vite',
        start: 'node dist/main.js',
        check: 'npm run typecheck',
        'test:unit': 'vitest run',
        'test:e2e': 'playwright test',
        'lint:fix': 'eslint . --fix',
        'build:prod': 'vite build --mode production',
        'dev:electron': 'electron .',
        'start:debug': 'node --inspect dist/main.js',
        release: 'node scripts/release.mjs',
      },
    }));
    write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }));
    write(root, '.claude/worktrees/stale/package.json', '{"name":"stale"}\n');
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
    expect(proposals.every((p) => p.sources.length <= 4)).toBe(true);
    expect(
      proposals.flatMap((proposal) => proposal.sources)
        .every((source) => !/(?:^|\/)(?:package-lock\.json|\.claude)(?:\/|$)/.test(source.locator)),
    ).toBe(true);
    expect(proposals.some((p) => p.targetPath.includes('architecture'))).toBe(true);
    expect(proposals[0].content).toContain('Auto-proposed');
    for (const proposal of proposals.filter((item) => item.targetPath.endsWith('.md'))) {
      for (const source of proposal.sources) {
        expect(
          proposal.content,
          `${proposal.targetPath} does not identify bound source ${source.locator}`,
        ).toContain(source.locator);
      }
    }
    const business = proposals.find((proposal) => proposal.targetPath.endsWith('business-model.md'));
    expect(business?.content).toContain('Developers using AI CLIs');
    expect(business?.content).not.toContain('TODO');
    expect(business?.sources.map((source) => source.locator)).toEqual(['PRODUCT.md']);
    expect(business && isAutoReviewableBootstrapProposal(business)).toBe(true);
    const testing = proposals.find((proposal) => proposal.targetPath.endsWith('testing.md'));
    expect(testing?.sources.map((source) => source.locator)).toEqual(['package.json']);
    const scripts = proposals.find((proposal) =>
      proposal.targetPath.endsWith('package-scripts.json'));
    expect(scripts?.content).toContain('Selected operational scripts from package.json');
    expect(scripts?.content).toContain('"claimKey": "package.scripts.selected"');
  });

  it('keeps complete product evidence bound to the full source hash', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-product-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-product-cache-'));
    roots.push(root, cacheRoot);
    const marker = 'END-OF-SOURCE-EVIDENCE';
    const product = `# Product\n\n${'x'.repeat(52_000)}\n${marker}\n`;
    write(root, 'package.json', JSON.stringify({ name: 'product-app' }));
    write(root, 'PRODUCT.md', product);
    write(root, 'src/main.ts', 'export const main = true;\n');

    const map = await new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    }).ensure(scopeFor(root), { reason: 'mcp' });
    const proposals = buildContextBootstrapProposals(scopeFor(root), map);
    const overview = proposals.find((proposal) =>
      proposal.targetPath.endsWith('project-overview.md'));

    expect(overview?.content).toContain(product);
    expect(overview?.content).toContain(marker);
    expect(overview?.sources.find((source) => source.locator === 'PRODUCT.md')?.sourceHash)
      .toBe(createHash('sha256').update(product).digest('hex'));
  });

  it('does not assert root package scripts when package.json is not a bound manifest', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-testing-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-testing-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'package.json', JSON.stringify({
      name: 'testing-app',
      scripts: { test: 'vitest --run' },
    }));
    write(root, 'pyproject.toml', '[project]\nname = "testing-app"\n');
    write(root, 'src/main.ts', 'export const main = true;\n');

    const discovered = await new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    }).ensure(scopeFor(root), { reason: 'mcp' });
    const map = Object.freeze({
      ...discovered,
      inventory: Object.freeze({
        ...discovered.inventory,
        manifests: Object.freeze(['pyproject.toml']),
      }),
    });
    const testing = buildContextBootstrapProposals(scopeFor(root), map).find((proposal) =>
      proposal.targetPath.endsWith('testing.md'));

    expect(testing?.sources.map((source) => source.locator)).toEqual(['pyproject.toml']);
    expect(testing?.content).toContain('No root `package.json` is bound');
    expect(testing?.content).not.toContain('`test`: `vitest --run`');
  });
});
