import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  createContextAttestation,
  inspectContextAttestations,
  writeContextAttestation,
} from './context-attestation';

const roots: string[] = [];

function fixture(): { root: string; scope: ProjectExecutionScope } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-attestation-')));
  roots.push(root);
  return {
    root,
    scope: Object.freeze({
      version: 1,
      installationId: 'installation-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: root,
      identitySource: 'manifest',
    }),
  };
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return createHash('sha256').update(content).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('portable context attestations', () => {
  it('binds target and real source bytes to independent author/reviewer identities', () => {
    const { root, scope } = fixture();
    const sourceHash = write(root, 'src/billing/rules.ts', 'export const trialDays = 14;\n');
    const targetHash = write(
      root,
      '.context/docs/business-model.md',
      '# Modelo\nO teste gratuito dura 14 dias.\n',
    );

    const attestation = createContextAttestation(scope, {
      targetPath: '.context/docs/business-model.md',
      targetHash,
      sources: [{ type: 'file', locator: 'src/billing/rules.ts', sourceHash }],
      author: { id: 'context-author', sessionId: 'session-author', provider: 'codex' },
      reviewer: { id: 'context-reviewer', sessionId: 'session-reviewer', provider: 'claude' },
      reviewedAt: '2026-07-10T12:00:00.000Z',
      nexusVersion: '0.12.0',
    });
    const relative = writeContextAttestation(scope, attestation);
    const inspection = inspectContextAttestations(scope);

    expect(relative).toBe(`.context/nexus/attestations/${attestation.id}.json`);
    expect(attestation.id).toMatch(/^att-[a-f0-9]{40}$/);
    expect(attestation.author).not.toHaveProperty('sessionId');
    expect(attestation.author.sessionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(inspection.diagnostics).toEqual([]);
    expect(inspection.attestations).toHaveLength(1);
    expect(inspection.attestations[0]).toEqual(attestation);
    expect(inspection.bindingHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects author identity/session aliases while allowing shared provider provenance', () => {
    const { root, scope } = fixture();
    const sourceHash = write(root, 'README.md', '# Product\n');
    const targetHash = write(root, '.context/docs/project-overview.md', '# Product\n');
    const base = {
      targetPath: '.context/docs/project-overview.md',
      targetHash,
      sources: [{ type: 'file' as const, locator: 'README.md', sourceHash }],
      author: { id: 'agent-a', sessionId: 'session-a', provider: 'codex' },
      reviewedAt: '2026-07-10T12:00:00.000Z',
      nexusVersion: '0.12.0',
    };

    expect(() => createContextAttestation(scope, {
      ...base,
      reviewer: { id: 'agent-a', sessionId: 'session-b', provider: 'claude' },
    })).toThrow(/independent/i);
    expect(() => createContextAttestation(scope, {
      ...base,
      reviewer: { id: 'agent-b', sessionId: 'session-a', provider: 'codex' },
    })).toThrow(/independent/i);
    expect(
      createContextAttestation(scope, {
        ...base,
        reviewer: {
          id: 'agent-b',
          sessionId: 'session-b',
          provider: 'codex',
        },
      }).reviewer.provider,
    ).toBe('codex');
  });

  it('fails closed when a reviewed target or its source changes', () => {
    const { root, scope } = fixture();
    const sourceHash = write(root, 'src/tenant.ts', 'export const tenantRequired = true;\n');
    const targetPath = '.context/nexus/invariants/tenant.json';
    const targetHash = write(root, targetPath, JSON.stringify({ schemaVersion: 1, facts: [{
      id: 'tenant-required',
      statement: 'Tenant is required.',
      claimKey: 'tenant.required',
      value: true,
    }] }));
    const attestation = createContextAttestation(scope, {
      targetPath,
      targetHash,
      sources: [{ type: 'file', locator: 'src/tenant.ts', sourceHash }],
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      reviewer: { id: 'reviewer', sessionId: 'review-session', provider: 'claude' },
      reviewedAt: '2026-07-10T12:00:00.000Z',
      nexusVersion: '0.12.0',
    });
    writeContextAttestation(scope, attestation);

    write(root, 'src/tenant.ts', 'export const tenantRequired = false;\n');
    const sourceChanged = inspectContextAttestations(scope);
    expect(sourceChanged.attestations).toEqual([]);
    expect(sourceChanged.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'source-hash-mismatch' }),
    );

    write(root, 'src/tenant.ts', 'export const tenantRequired = true;\n');
    write(root, targetPath, '{"schemaVersion":1,"facts":[]}');
    const targetChanged = inspectContextAttestations(scope);
    expect(targetChanged.attestations).toEqual([]);
    expect(targetChanged.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'target-hash-mismatch' }),
    );
  });

  it('retires a superseded attestation once the target is reviewed again', () => {
    // Field trap (28/07): re-reviewing a context doc writes a NEW attestation
    // and leaves the previous file on disk. Its targetHash describes bytes that
    // no longer exist, so it failed target-hash-mismatch forever — a permanent
    // `invalid-context-attestation` blocker that kept every Guided mission
    // stuck in blocked_technical.
    const { root, scope } = fixture();
    const targetPath = '.context/docs/architecture.md';
    const identity = {
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      reviewer: { id: 'reviewer', sessionId: 'review-session', provider: 'claude' },
      nexusVersion: '0.12.0',
    };
    const firstSourceHash = write(root, 'src/shared/types.ts', 'export type A = 1;\n');
    const firstTargetHash = write(root, targetPath, '# Arquitetura\nPrimeira revisão.\n');
    const superseded = createContextAttestation(scope, {
      ...identity,
      targetPath,
      targetHash: firstTargetHash,
      sources: [{ type: 'file', locator: 'src/shared/types.ts', sourceHash: firstSourceHash }],
      reviewedAt: '2026-07-13T12:00:00.000Z',
    });
    writeContextAttestation(scope, superseded);

    // The doc is rewritten and reviewed again; the old attestation stays behind.
    const nextSourceHash = write(root, 'src/shared/types.ts', 'export type A = 2;\n');
    const nextTargetHash = write(root, targetPath, '# Arquitetura\nSegunda revisão.\n');
    const active = createContextAttestation(scope, {
      ...identity,
      targetPath,
      targetHash: nextTargetHash,
      sources: [{ type: 'file', locator: 'src/shared/types.ts', sourceHash: nextSourceHash }],
      reviewedAt: '2026-07-18T12:00:00.000Z',
    });
    writeContextAttestation(scope, active);

    const inspection = inspectContextAttestations(scope);

    expect(inspection.diagnostics).toEqual([]);
    expect(inspection.attestations).toEqual([active]);
  });

  it('does not follow symlinked evidence sources', () => {
    const { root, scope } = fixture();
    const outside = path.join(os.tmpdir(), `nexus-attestation-outside-${Date.now()}`);
    fs.writeFileSync(outside, 'secret');
    const source = path.join(root, 'evidence.txt');
    fs.symlinkSync(outside, source);
    const targetHash = write(root, '.context/docs/testing.md', '# Testing\n');
    try {
      expect(() => createContextAttestation(scope, {
        targetPath: '.context/docs/testing.md',
        targetHash,
        sources: [{
          type: 'file',
          locator: 'evidence.txt',
          sourceHash: createHash('sha256').update('secret').digest('hex'),
        }],
        author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
        reviewer: { id: 'reviewer', sessionId: 'review-session', provider: 'claude' },
        reviewedAt: '2026-07-10T12:00:00.000Z',
        nexusVersion: '0.12.0',
      })).toThrow(/symbolic link/i);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
