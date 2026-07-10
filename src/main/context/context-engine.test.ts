import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { detectContextConflicts } from './ambiguity-engine';
import { ingestProjectContext } from './context-ingestor';
import { compileContextSnapshot } from './snapshot-compiler';
import { TruthGraph } from './truth-graph';
import {
  createContextAttestation,
  writeContextAttestation,
} from './context-attestation';

const roots: string[] = [];

function project(): { root: string; scope: ProjectExecutionScope } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-')));
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

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Context Ingestor + Truth Graph', () => {
  it('imports Dotcontext-compatible docs as sourced candidates, never silent truth', () => {
    const { root, scope } = project();
    write(root, '.context/docs/business-model.md', '# Negócio\nClientes pagam por uso.');
    write(root, 'AGENTS.md', '# Regras\nSempre validar o tenant.');

    const corpus = ingestProjectContext(scope);

    expect(corpus.candidates).toHaveLength(2);
    expect(corpus.facts).toHaveLength(0);
    expect(corpus.candidates[0].source.locator).toMatch(/AGENTS|business-model/);
    expect(corpus.candidates.every((item) => item.sourceHash.length === 64)).toBe(true);
    expect(corpus.candidates.every((item) => item.status === 'candidate')).toBe(true);
    expect(corpus.contextRevision).toMatch(/^[a-f0-9]{64}$/);

    const contentHash = (relative: string) => createHash('sha256')
      .update(fs.readFileSync(path.join(root, relative)))
      .digest('hex');
    writeContextAttestation(scope, createContextAttestation(scope, {
      targetPath: '.context/docs/business-model.md',
      targetHash: contentHash('.context/docs/business-model.md'),
      sources: [{ type: 'file', locator: 'AGENTS.md', sourceHash: contentHash('AGENTS.md') }],
      author: { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
      reviewer: { id: 'reviewer-b', sessionId: 'reviewer-session', provider: 'claude' },
      reviewedAt: '2026-07-10T12:00:00.000Z',
      nexusVersion: 'test',
    }));
    expect(ingestProjectContext(scope).contextRevision).not.toBe(corpus.contextRevision);
  });

  it('loads authored structured facts with file provenance and changes revision on source edit', () => {
    const { root, scope } = project();
    const relative = '.context/nexus/invariants/tenant.json';
    write(
      root,
      relative,
      JSON.stringify({
        schemaVersion: 1,
        facts: [
          {
            id: 'inv-tenant',
            statement: 'Toda consulta pertence a exatamente um tenant.',
            claimKey: 'data.tenant.required',
            value: true,
            kind: 'asserted',
            domains: ['data'],
            relatedSymbols: ['tenantId'],
          },
        ],
      }),
    );

    const first = ingestProjectContext(scope);
    expect(first.facts[0]).toMatchObject({
      id: 'inv-tenant',
      category: 'invariant',
      source: { type: 'file', locator: relative },
    });
    expect(first.facts[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);

    write(
      root,
      relative,
      fs.readFileSync(path.join(root, relative), 'utf8').replace('exatamente um', 'um único'),
    );
    const second = ingestProjectContext(scope);
    expect(second.contextRevision).not.toBe(first.contextRevision);
  });

  it('fails closed on symlinked context files instead of reading outside the project', () => {
    const { root, scope } = project();
    const outside = path.join(os.tmpdir(), `nexus-secret-${Date.now()}.md`);
    fs.writeFileSync(outside, 'outside secret');
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.context', 'docs', 'leak.md'));
    try {
      expect(() => ingestProjectContext(scope)).toThrow(/symbolic link/i);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('requires independent validation before promoting an unstructured candidate', () => {
    const { root, scope } = project();
    write(root, '.context/docs/project-overview.md', '# Projeto\nFluxo de checkout.');
    const corpus = ingestProjectContext(scope);
    const graph = new TruthGraph(corpus);
    const candidate = corpus.candidates[0];

    expect(() =>
      graph.promoteCandidate(candidate.id, {
        validatorId: candidate.producerId,
        kind: 'asserted',
        claimKey: 'project.flow',
        value: 'checkout',
        category: 'domain',
      }),
    ).toThrow(/independent/i);
    const fact = graph.promoteCandidate(candidate.id, {
      validatorId: 'reviewer-b',
      kind: 'asserted',
      claimKey: 'project.flow',
      value: 'checkout',
      category: 'domain',
    });
    expect(fact.source.locator).toBe('.context/docs/project-overview.md');
  });
});

describe('ambiguity and task-specific snapshots', () => {
  it('blocks contradictory authoritative claims and unsafe inferred invariants', () => {
    const { scope } = project();
    const source = {
      type: 'file' as const,
      locator: '.context/nexus/facts/a.json',
    };
    const facts = [
      {
        id: 'fact-a',
        projectId: scope.projectId,
        statement: 'Sessão expira em 30 minutos.',
        claimKey: 'auth.session.ttl',
        value: 30,
        kind: 'asserted' as const,
        category: 'domain' as const,
        source,
        sourceHash: 'a'.repeat(64),
        domains: ['auth'],
        relatedSymbols: ['SESSION_TTL'],
        confidence: 1,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'fact-b',
        projectId: scope.projectId,
        statement: 'Sessão expira em 60 minutos.',
        claimKey: 'auth.session.ttl',
        value: 60,
        kind: 'observed' as const,
        category: 'test' as const,
        source: { ...source, locator: 'src/auth/session.test.ts' },
        sourceHash: 'b'.repeat(64),
        domains: ['auth'],
        relatedSymbols: ['SESSION_TTL'],
        confidence: 1,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'fact-inferred',
        projectId: scope.projectId,
        statement: 'Todo usuário é administrador.',
        claimKey: 'auth.user.admin',
        value: true,
        kind: 'inferred' as const,
        category: 'invariant' as const,
        source: { type: 'decision' as const, locator: 'inference:model-a' },
        sourceHash: 'c'.repeat(64),
        domains: ['auth'],
        relatedSymbols: [],
        confidence: 0.9,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    ];

    const conflicts = detectContextConflicts({
      facts,
      requiredFactIds: ['fact-inferred'],
      knownSymbols: new Set(['SESSION_TTL']),
      impactedDomains: ['auth'],
    });

    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'contradiction', severity: 'blocking' }),
        expect.objectContaining({ kind: 'unsafe-inference', severity: 'blocking' }),
      ]),
    );
  });

  it('marks removed symbols stale and compiles a deterministic, relevant capsule', () => {
    const { scope } = project();
    const facts = [
      {
        id: 'inv-auth',
        projectId: scope.projectId,
        statement: 'Tokens nunca entram em logs.',
        claimKey: 'auth.logs.tokens',
        value: false,
        kind: 'asserted' as const,
        category: 'invariant' as const,
        source: { type: 'file' as const, locator: '.context/nexus/invariants/auth.json' },
        sourceHash: 'a'.repeat(64),
        domains: ['auth'],
        relatedSymbols: ['redactToken'],
        confidence: 1,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'fact-billing',
        projectId: scope.projectId,
        statement: 'Faturas fecham todo dia 1.',
        claimKey: 'billing.close.day',
        value: 1,
        kind: 'asserted' as const,
        category: 'domain' as const,
        source: { type: 'file' as const, locator: '.context/nexus/facts/billing.json' },
        sourceHash: 'b'.repeat(64),
        domains: ['billing'],
        relatedSymbols: ['closeInvoice'],
        confidence: 1,
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    ];
    const conflicts = detectContextConflicts({
      facts,
      requiredFactIds: ['inv-auth'],
      knownSymbols: new Set(),
      impactedDomains: ['auth'],
    });
    expect(conflicts).toContainEqual(
      expect.objectContaining({ kind: 'stale-reference', severity: 'blocking' }),
    );

    const input = {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      contextRevision: 'r'.repeat(64),
      goal: 'Corrigir a redação de tokens',
      impactedDomains: ['auth'],
      impactedSymbols: ['redactToken'],
      requiredFactIds: ['inv-auth'],
      facts,
      conflicts: [],
      regressions: ['Nunca registrar Authorization'],
      requiredSensors: ['unit', 'secret-scan'],
    };
    const first = compileContextSnapshot(input);
    const second = compileContextSnapshot({
      ...input,
      impactedDomains: [...input.impactedDomains].reverse(),
      requiredSensors: [...input.requiredSensors].reverse(),
    });

    expect(first.factIds).toEqual(['inv-auth']);
    expect(first.markdown).toContain('Tokens nunca entram em logs');
    expect(first.markdown).not.toContain('Faturas fecham');
    expect(first.contextHash).toBe(second.contextHash);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
