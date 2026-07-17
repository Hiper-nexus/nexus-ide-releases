import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ensureContextScaffold,
  inspectContextReadiness,
} from './context-doctor';
import {
  createContextAttestation,
  writeContextAttestation,
} from './context-attestation';

const roots: string[] = [];

function fixture(): { root: string; scope: ProjectExecutionScope } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doctor-')));
  roots.push(root);
  return {
    root,
    scope: Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: root,
      identitySource: 'manifest',
    }),
  };
}

function write(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

function hash(root: string, relative: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(root, relative)))
    .digest('hex');
}

function attest(
  root: string,
  scope: ProjectExecutionScope,
  targetPath: string,
  sourcePath: string,
): void {
  writeContextAttestation(scope, createContextAttestation(scope, {
    targetPath,
    targetHash: hash(root, targetPath),
    sources: [{ type: 'file', locator: sourcePath, sourceHash: hash(root, sourcePath) }],
    author: { id: 'author-a', sessionId: `author:${targetPath}`, provider: 'codex' },
    reviewer: { id: 'reviewer-b', sessionId: `reviewer:${targetPath}`, provider: 'claude' },
    reviewedAt: '2026-07-10T12:00:00.000Z',
    nexusVersion: '0.12.0-test',
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Context Doctor', () => {
  it('reports concrete blockers instead of pretending missing business context is ready', () => {
    const { scope } = fixture();
    const report = inspectContextReadiness(scope, { knownSymbols: new Set() });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-business-context' }),
        expect.objectContaining({ code: 'missing-structured-invariants' }),
        expect.objectContaining({ code: 'missing-policy' }),
        expect.objectContaining({ code: 'missing-sensors' }),
      ]),
    );
  });

  it('creates only a safe scaffold and never fabricates business facts', () => {
    const { root, scope } = fixture();
    const result = ensureContextScaffold(scope);

    expect(result.created).toEqual(
      expect.arrayContaining([
        '.context/config/policy.json',
        '.context/config/sensors.json',
      ]),
    );
    expect(fs.existsSync(path.join(root, '.context/nexus/facts'))).toBe(true);
    expect(fs.readdirSync(path.join(root, '.context/nexus/facts'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '.context/nexus/attestations'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.context/nexus/evidence'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.context/docs/business-model.md'))).toBe(false);
  });

  it('becomes ready only after independent attestations bind docs and invariants to evidence', () => {
    const { root, scope } = fixture();
    write(root, 'PRODUCT-SOURCE.md', '# Fonte\nEscopo, negócio, domínio, arquitetura e testes.');
    for (const name of [
      'project-overview',
      'business-model',
      'domain-glossary',
      'architecture',
      'testing',
    ]) {
      write(root, `.context/docs/${name}.md`, `# ${name}\nFonte versionada.`);
    }
    ensureContextScaffold(scope);
    write(root, '.context/nexus/invariants/core.json', {
      schemaVersion: 1,
      facts: [
        {
          id: 'inv-core',
          statement: 'Toda mutação valida o escopo do projeto.',
          claimKey: 'project.scope.required',
          value: true,
          kind: 'asserted',
          domains: ['core'],
          relatedSymbols: ['ProjectExecutionScope'],
        },
      ],
    });

    const unreviewed = inspectContextReadiness(scope, {
      knownSymbols: new Set(['ProjectExecutionScope']),
    });
    expect(unreviewed.ready).toBe(false);
    expect(unreviewed.blockers).toContainEqual(
      expect.objectContaining({ code: 'missing-context-attestation' }),
    );

    for (const name of [
      'project-overview',
      'business-model',
      'domain-glossary',
      'architecture',
      'testing',
    ]) {
      attest(root, scope, `.context/docs/${name}.md`, 'PRODUCT-SOURCE.md');
    }
    attest(root, scope, '.context/nexus/invariants/core.json', 'PRODUCT-SOURCE.md');

    const report = inspectContextReadiness(scope, {
      knownSymbols: new Set(['ProjectExecutionScope']),
    });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.contextRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(report.sensorIds).toEqual(expect.arrayContaining(['typecheck', 'unit']));
  });

  it('sensores typecheck/unit ausentes viram WARNING, não bloqueiam o freeze', () => {
    const { root, scope } = fixture();
    write(root, 'PRODUCT-SOURCE.md', '# Fonte\nEscopo, negócio, domínio, arquitetura e testes.');
    for (const name of [
      'project-overview',
      'business-model',
      'domain-glossary',
      'architecture',
      'testing',
    ]) {
      write(root, `.context/docs/${name}.md`, `# ${name}\nFonte versionada.`);
    }
    ensureContextScaffold(scope);
    // Substitui o sensors.json por um SEM typecheck/unit (só um sensor custom).
    write(root, '.context/config/sensors.json', {
      schemaVersion: 1,
      sensors: [
        { id: 'lint', command: ['npm', 'run', 'lint'], timeoutMs: 60_000, network: false },
      ],
    });
    write(root, '.context/nexus/invariants/core.json', {
      schemaVersion: 1,
      facts: [
        {
          id: 'inv-core',
          statement: 'Toda mutação valida o escopo do projeto.',
          claimKey: 'project.scope.required',
          value: true,
          kind: 'asserted',
          domains: ['core'],
          relatedSymbols: ['ProjectExecutionScope'],
        },
      ],
    });
    for (const name of [
      'project-overview',
      'business-model',
      'domain-glossary',
      'architecture',
      'testing',
    ]) {
      attest(root, scope, `.context/docs/${name}.md`, 'PRODUCT-SOURCE.md');
    }
    attest(root, scope, '.context/nexus/invariants/core.json', 'PRODUCT-SOURCE.md');

    const report = inspectContextReadiness(scope, {
      knownSymbols: new Set(['ProjectExecutionScope']),
    });
    // A ausência de typecheck/unit NÃO trava o freeze — vira warning.
    expect(report.ready).toBe(true);
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'missing-required-sensors' }),
    );
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-required-sensors' }),
    );
  });

  it('warns when only source bytes drift and the reviewed target is identical', () => {
    const { root, scope } = fixture();
    write(root, 'README.md', '# Product v1');
    write(root, '.context/docs/business-model.md', '# Business v1');
    attest(root, scope, '.context/docs/business-model.md', 'README.md');
    write(root, 'README.md', '# Product v2');

    const report = inspectContextReadiness(scope, { knownSymbols: new Set() });

    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'invalid-context-attestation' }),
    );
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({
        code: 'missing-context-attestation',
        details: expect.arrayContaining(['.context/docs/business-model.md']),
      }),
    );
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'invalid-context-attestation' }),
    );
  });

  it('blocks when an attested target is absent', () => {
    const { root, scope } = fixture();
    write(root, 'README.md', '# Product v1');
    write(root, '.context/docs/business-model.md', '# Business v1');
    attest(root, scope, '.context/docs/business-model.md', 'README.md');
    fs.rmSync(path.join(root, '.context/docs/business-model.md'));

    const report = inspectContextReadiness(scope, { knownSymbols: new Set() });

    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: 'invalid-context-attestation',
        details: expect.arrayContaining([
          expect.stringContaining('attested target is unavailable'),
        ]),
      }),
    );
  });

  it('blocks malformed policy rather than falling back to permissive defaults', () => {
    const { root, scope } = fixture();
    ensureContextScaffold(scope);
    write(root, '.context/config/policy.json', { allowEverything: true });

    const report = inspectContextReadiness(scope, { knownSymbols: new Set() });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: 'invalid-policy' }),
    );
  });
});
