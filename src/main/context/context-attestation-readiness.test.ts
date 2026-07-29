import { describe, expect, it } from 'vitest';
import type { ContextAttestationDiagnostic } from './context-attestation';
import {
  authorityFactLocators,
  collectAuthorityTargets,
  partitionAttestationDiagnostics,
} from './context-attestation-readiness';
import type { ContextFact } from './context-types';

function diag(
  partial: Partial<ContextAttestationDiagnostic> &
    Pick<ContextAttestationDiagnostic, 'code' | 'message'>,
): ContextAttestationDiagnostic {
  return Object.freeze({
    code: partial.code,
    message: partial.message,
    attestationPath: partial.attestationPath,
    targetPath: partial.targetPath,
  });
}

function fact(
  locator: string,
  category: ContextFact['category'],
  kind: ContextFact['kind'] = 'observed',
): ContextFact {
  return Object.freeze({
    id: `fact-${locator}`,
    projectId: 'p',
    statement: 'x',
    claimKey: 'x',
    value: true,
    kind,
    category,
    source: Object.freeze({ type: 'file' as const, locator }),
    sourceHash: 'a'.repeat(64),
    domains: Object.freeze(['core']),
    relatedSymbols: Object.freeze([]),
    confidence: 1,
    validFrom: '1970-01-01T00:00:00.000Z',
  });
}

describe('partitionAttestationDiagnostics', () => {
  it('quarantines unparseable attestation files instead of hard-blocking', () => {
    const partitioned = partitionAttestationDiagnostics([
      diag({
        code: 'invalid-attestation',
        message: 'invalid context attestation .context/nexus/attestations/att-overclock.json',
        attestationPath:
          '.context/nexus/attestations/att-overclock-jarvis-voz-arquitetura.json',
      }),
      diag({
        code: 'source-hash-mismatch',
        message: 'source changed',
        attestationPath: '.context/nexus/attestations/att-abc.json',
        targetPath: '.context/docs/architecture.md',
      }),
    ]);

    expect(partitioned.blocking).toEqual([]);
    expect(partitioned.quarantined).toHaveLength(1);
    expect(partitioned.sourceDriftTargets).toEqual(
      new Set(['.context/docs/architecture.md']),
    );
  });

  it('still blocks target-hash-mismatch when nothing supersedes it', () => {
    const partitioned = partitionAttestationDiagnostics([
      diag({
        code: 'target-hash-mismatch',
        message: 'target changed',
        attestationPath: '.context/nexus/attestations/att-dead.json',
        targetPath: '.context/docs/business-model.md',
      }),
    ]);
    expect(partitioned.blocking).toHaveLength(1);
    expect(partitioned.quarantined).toEqual([]);
  });
});

describe('authorityFactLocators', () => {
  it('does not elevate observed DESIGN.md extractions to attestation targets', () => {
    const locators = authorityFactLocators([
      fact('DESIGN.md', 'architecture', 'observed'),
      fact('.context/nexus/invariants/package-name.json', 'invariant', 'asserted'),
      fact('AGENTS.md', 'domain', 'observed'),
    ]);
    expect(locators).toEqual([
      '.context/nexus/invariants/package-name.json',
    ]);
  });

  it('keeps required docs plus authority fact locators', () => {
    const targets = collectAuthorityTargets({
      requiredDocs: [
        '.context/docs/architecture.md',
        '.context/docs/missing.md',
      ],
      factLocators: ['.context/nexus/invariants/core.json'],
      fileExists: (relative) => relative !== '.context/docs/missing.md',
    });
    expect([...targets].sort()).toEqual([
      '.context/docs/architecture.md',
      '.context/nexus/invariants/core.json',
    ]);
  });
});
