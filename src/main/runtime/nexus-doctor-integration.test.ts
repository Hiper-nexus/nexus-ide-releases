import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  createContextAttestation,
  writeContextAttestation,
} from '../context/context-attestation';
import { ensureContextScaffold, inspectContextReadiness } from '../context/context-doctor';
import { buildProjectSymbolIndex } from '../context/symbol-index';
import { createProjectManifest } from '../persistence/project-identity';
import { ProjectRuntimeManager } from './project-runtime-manager';
import { inspectNexusReadiness, runtimeHealthProbeFromManager } from './nexus-doctor';

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return createHash('sha256').update(content).digest('hex');
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Nexus Doctor real runtime integration', () => {
  it('proves Git, physical SQLite and independently attested context together', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doctor-real-')));
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doctor-real-runtime-'));
    roots.push(root, runtimeRoot);
    const scope: ProjectExecutionScope = Object.freeze({
      version: 1,
      installationId: 'installation-doctor-real',
      projectId: '11111111-1111-4111-8111-111111111111',
      checkoutId: 'checkout-doctor-real',
      rootRealPath: root,
      identitySource: 'manifest',
    });
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Nexus Test');
    git(root, 'config', 'user.email', 'nexus@example.test');
    const sourcePath = 'PRODUCT-SOURCE.md';
    write(root, sourcePath, '# Source\nBusiness, architecture, scope and tests.\n');
    git(root, 'add', sourcePath);
    git(root, 'commit', '-qm', 'initial product source');
    const manifest = createProjectManifest(root, {
      projectId: scope.projectId,
      name: 'Doctor fixture',
    });
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      projectId: scope.projectId,
      repository: { vcs: 'git' },
    });
    expect(manifest.repository.anchorCommits).toContain(git(root, 'rev-parse', 'HEAD'));
    write(root, '.nexus/project.json', `${JSON.stringify(manifest, null, 2)}\n`);
    ensureContextScaffold(scope);
    const targets = [
      ['.context/docs/project-overview.md', '# Project\nOverview.\n'],
      ['.context/docs/business-model.md', '# Business\nUsage model.\n'],
      ['.context/docs/domain-glossary.md', '# Glossary\nAccount means customer.\n'],
      ['.context/docs/architecture.md', '# Architecture\nScoped runtime.\n'],
      ['.context/docs/testing.md', '# Testing\nUnit and integration.\n'],
      ['.context/nexus/invariants/core.json', JSON.stringify({
        schemaVersion: 1,
        facts: [{
          id: 'scope-required',
          statement: 'Every mutation is scoped.',
          claimKey: 'project.scope.required',
          value: true,
          kind: 'asserted',
          domains: ['core'],
          relatedSymbols: [],
        }],
      })],
    ] as const;
    const sourceHash = createHash('sha256')
      .update(fs.readFileSync(path.join(root, sourcePath)))
      .digest('hex');
    for (const [targetPath, content] of targets) {
      const targetHash = write(root, targetPath, content);
      writeContextAttestation(scope, createContextAttestation(scope, {
        targetPath,
        targetHash,
        sources: [{ type: 'file', locator: sourcePath, sourceHash }],
        author: { id: 'author', sessionId: `author:${targetPath}`, provider: 'codex' },
        reviewer: { id: 'reviewer', sessionId: `reviewer:${targetPath}`, provider: 'claude' },
        reviewedAt: '2026-07-10T12:00:00.000Z',
        nexusVersion: 'test',
      }));
    }
    git(root, 'add', '.nexus', '.context', sourcePath);
    git(root, 'commit', '-qm', 'reviewed context');

    const manager = new ProjectRuntimeManager({ baseDir: runtimeRoot, appVersion: 'test' });
    managers.push(manager);
    const report = inspectNexusReadiness({
      scope,
      platform: 'darwin',
      runtime: runtimeHealthProbeFromManager(manager),
      inspectContext: (requestedScope) => inspectContextReadiness(requestedScope, {
        knownSymbols: buildProjectSymbolIndex(requestedScope).symbols,
      }),
      listProviders: () => ['codex', 'claude', 'gemini'].map((adapterId) => ({
        adapterId,
        enabled: true,
        installed: true,
        kind: 'cli-pty' as const,
        authStrategy: 'subscription',
        readOnlyCapable: true,
      })),
      multiPc: {
        leaseBackendConfigured: true,
        syncBackendConfigured: true,
        requireSharedExecution: true,
      },
      pathExists: (candidate) =>
        candidate === '/usr/bin/sandbox-exec' || fs.existsSync(candidate),
    });

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.checks.map((check) => check.check)).toHaveLength(9);
  });
});
