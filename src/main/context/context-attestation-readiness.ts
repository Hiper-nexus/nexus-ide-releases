import type { ProjectExecutionScope } from '../../shared/types';
import type { ContextAttestationDiagnostic } from './context-attestation';
import type { ContextFact } from './context-types';

/**
 * Parse/entry failures cannot name a targetPath, so they must not hard-block
 * Guided readiness. Field trap (28/07): a hand-written attestation with an
 * illegal id (`att-overclock-…` instead of `att-[40 hex]`) poisoned every
 * approveIntent with invalid-context-attestation.
 */
const ATTESTATION_PARSE_QUARANTINE_CODES: ReadonlySet<string> = new Set([
  'invalid-attestation',
  'invalid-attestation-entry',
]);

export interface PartitionedAttestationDiagnostics {
  readonly blocking: readonly ContextAttestationDiagnostic[];
  readonly sourceDrift: readonly ContextAttestationDiagnostic[];
  readonly sourceDriftTargets: ReadonlySet<string>;
  readonly quarantined: readonly ContextAttestationDiagnostic[];
}

export function partitionAttestationDiagnostics(
  diagnostics: readonly ContextAttestationDiagnostic[],
): PartitionedAttestationDiagnostics {
  const byPath = new Map<string, ContextAttestationDiagnostic[]>();
  const blocking = diagnostics.filter((item) => {
    if (!item.attestationPath) return true;
    const group = byPath.get(item.attestationPath) ?? [];
    group.push(item);
    byPath.set(item.attestationPath, group);
    return false;
  });
  const sourceDrift: ContextAttestationDiagnostic[] = [];
  const quarantined: ContextAttestationDiagnostic[] = [];
  const sourceDriftTargets = new Set<string>();
  for (const group of byPath.values()) {
    const isSourceDriftOnly = group.every(
      (item) => item.code === 'source-hash-mismatch' && item.targetPath,
    );
    if (isSourceDriftOnly) {
      sourceDrift.push(...group);
      for (const item of group) sourceDriftTargets.add(item.targetPath!);
      continue;
    }
    const isParseQuarantineOnly = group.every((item) =>
      ATTESTATION_PARSE_QUARANTINE_CODES.has(item.code),
    );
    if (isParseQuarantineOnly) {
      quarantined.push(...group);
      continue;
    }
    blocking.push(...group);
  }
  return Object.freeze({
    blocking: Object.freeze(blocking),
    sourceDrift: Object.freeze(sourceDrift),
    sourceDriftTargets,
    quarantined: Object.freeze(quarantined),
  });
}

/**
 * Observed extractions from root docs (DESIGN.md, AGENTS.md, …) inform the
 * corpus but are not independent-review authority. Requiring attestation of
 * DESIGN.md blocked every Guided mission on this repo (28/07 field trap).
 */
export function authorityFactLocators(
  facts: readonly ContextFact[],
): readonly string[] {
  return Object.freeze(
    facts
      .filter((fact) => {
        const locator = fact.source.locator;
        if (locator.startsWith('.context/')) return true;
        return fact.category === 'invariant';
      })
      .map((fact) => fact.source.locator),
  );
}

export function collectAuthorityTargets(input: {
  readonly requiredDocs: readonly string[];
  readonly factLocators: readonly string[];
  readonly fileExists: (relative: string) => boolean;
}): ReadonlySet<string> {
  return new Set([
    ...input.requiredDocs.filter((relative) => input.fileExists(relative)),
    ...input.factLocators,
  ]);
}

/** Test seam: keep ProjectExecutionScope out of pure authority helpers. */
export function authorityTargetsForCorpus(input: {
  readonly scope: ProjectExecutionScope;
  readonly requiredDocs: readonly string[];
  readonly facts: readonly ContextFact[];
  readonly fileExists: (
    scope: ProjectExecutionScope,
    relative: string,
  ) => boolean;
}): ReadonlySet<string> {
  return collectAuthorityTargets({
    requiredDocs: input.requiredDocs,
    factLocators: authorityFactLocators(input.facts),
    fileExists: (relative) => input.fileExists(input.scope, relative),
  });
}
