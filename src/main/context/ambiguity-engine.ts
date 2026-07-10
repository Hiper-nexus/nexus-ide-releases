import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type {
  ContextConflict,
  ContextFact,
  ContextSourceRef,
} from './context-types';

export interface DetectContextConflictsInput {
  readonly facts: readonly ContextFact[];
  readonly requiredFactIds: readonly string[];
  readonly knownSymbols: ReadonlySet<string>;
  readonly impactedDomains: readonly string[];
}

function conflictId(
  kind: ContextConflict['kind'],
  claims: readonly string[],
  sources: readonly ContextSourceRef[],
): string {
  return `conflict:${createHash('sha256')
    .update(canonicalJson({ kind, claims: [...claims].sort(), sources }))
    .digest('hex')
    .slice(0, 32)}`;
}

function freezeConflict(conflict: ContextConflict): ContextConflict {
  return Object.freeze({
    ...conflict,
    claims: Object.freeze([...conflict.claims]),
    sources: Object.freeze(
      conflict.sources.map((source) => Object.freeze({ ...source })),
    ),
    affectedDomains: Object.freeze([...conflict.affectedDomains]),
  });
}

function authoritative(fact: ContextFact): boolean {
  return fact.kind === 'asserted' || fact.kind === 'observed';
}

function active(fact: ContextFact): boolean {
  if (fact.kind === 'deprecated') return false;
  if (!fact.validUntil) return true;
  return Date.parse(fact.validUntil) > Date.now();
}

function intersects(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((item) => right.has(item));
}

export function detectContextConflicts(
  input: DetectContextConflictsInput,
): readonly ContextConflict[] {
  const conflicts: ContextConflict[] = [];
  const required = new Set(input.requiredFactIds);
  const impactedDomains = new Set(input.impactedDomains);
  const activeFacts = input.facts.filter(active);

  for (const fact of activeFacts) {
    if (!fact.source.locator || !/^[a-f0-9]{64}$/i.test(fact.sourceHash)) {
      const sources = fact.source.locator ? [fact.source] : [];
      conflicts.push(
        freezeConflict({
          id: conflictId('missing-source', [fact.id], sources),
          kind: 'missing-source',
          severity: required.has(fact.id) ? 'blocking' : 'warning',
          claims: [fact.statement],
          sources,
          affectedDomains: [...fact.domains].sort(),
        }),
      );
    }
    if (
      fact.kind === 'inferred' &&
      (required.has(fact.id) || fact.category === 'invariant')
    ) {
      conflicts.push(
        freezeConflict({
          id: conflictId('unsafe-inference', [fact.id], [fact.source]),
          kind: 'unsafe-inference',
          severity: 'blocking',
          claims: [fact.statement],
          sources: [fact.source],
          affectedDomains: [...fact.domains].sort(),
        }),
      );
    }
    if (
      (required.has(fact.id) || intersects(fact.domains, impactedDomains)) &&
      fact.relatedSymbols.some((symbol) => !input.knownSymbols.has(symbol))
    ) {
      const missing = fact.relatedSymbols.filter(
        (symbol) => !input.knownSymbols.has(symbol),
      );
      conflicts.push(
        freezeConflict({
          id: conflictId('stale-reference', [fact.id, ...missing], [fact.source]),
          kind: 'stale-reference',
          severity: required.has(fact.id) ? 'blocking' : 'warning',
          claims: [fact.statement, ...missing.map((symbol) => `missing symbol: ${symbol}`)],
          sources: [fact.source],
          affectedDomains: [...fact.domains].sort(),
        }),
      );
    }
  }

  const byClaim = new Map<string, ContextFact[]>();
  for (const fact of activeFacts.filter(authoritative)) {
    const list = byClaim.get(fact.claimKey) ?? [];
    list.push(fact);
    byClaim.set(fact.claimKey, list);
  }
  for (const [claimKey, facts] of byClaim) {
    const values = new Set(facts.map((fact) => canonicalJson(fact.value)));
    if (values.size <= 1) continue;
    const domains = [...new Set(facts.flatMap((fact) => fact.domains))].sort();
    const sources = facts.map((fact) => fact.source);
    conflicts.push(
      freezeConflict({
        id: conflictId('contradiction', [claimKey, ...[...values].sort()], sources),
        kind: 'contradiction',
        severity: 'blocking',
        claims: facts.map((fact) => fact.statement).sort(),
        sources,
        affectedDomains: domains,
      }),
    );
  }

  return Object.freeze(
    conflicts.sort((left, right) => left.id.localeCompare(right.id)),
  );
}
