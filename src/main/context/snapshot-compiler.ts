import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type { ContextConflict, ContextFact } from './context-types';

export interface CompileContextSnapshotInput {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextRevision: string;
  readonly goal: string;
  readonly impactedDomains: readonly string[];
  readonly impactedSymbols: readonly string[];
  readonly requiredFactIds: readonly string[];
  readonly facts: readonly ContextFact[];
  readonly conflicts: readonly ContextConflict[];
  readonly regressions: readonly string[];
  readonly requiredSensors: readonly string[];
  readonly maxCharacters?: number;
}

export interface ContextSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly contextRevision: string;
  readonly goal: string;
  readonly impactedDomains: readonly string[];
  readonly impactedSymbols: readonly string[];
  readonly factIds: readonly string[];
  readonly conflictIds: readonly string[];
  readonly regressions: readonly string[];
  readonly requiredSensors: readonly string[];
  readonly markdown: string;
  readonly contextHash: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function factRelevant(
  fact: ContextFact,
  required: ReadonlySet<string>,
  domains: ReadonlySet<string>,
  symbols: ReadonlySet<string>,
): boolean {
  if (required.has(fact.id)) return true;
  if (fact.kind === 'deprecated' || fact.kind === 'conflict') return false;
  if (fact.category === 'glossary' && fact.domains.length === 0) return true;
  if (fact.domains.some((domain) => domains.has(domain))) return true;
  return fact.relatedSymbols.some((symbol) => symbols.has(symbol));
}

function sourceLabel(fact: ContextFact): string {
  const lines = fact.source.lines
    ? `:${fact.source.lines[0]}-${fact.source.lines[1]}`
    : '';
  return `${fact.source.type}:${fact.source.locator}${lines}`;
}

function renderSnapshot(
  input: CompileContextSnapshotInput,
  facts: readonly ContextFact[],
  conflicts: readonly ContextConflict[],
  domains: readonly string[],
  symbols: readonly string[],
  regressions: readonly string[],
  sensors: readonly string[],
): string {
  const lines = [
    '# Nexus Context Capsule',
    '',
    `Goal: ${input.goal}`,
    `Domains: ${domains.join(', ') || 'none declared'}`,
    `Symbols: ${symbols.join(', ') || 'none declared'}`,
    '',
    '## Sourced facts',
  ];
  if (facts.length === 0) lines.push('- No relevant sourced fact is available.');
  for (const fact of facts) {
    lines.push(
      `- [${fact.kind}/${fact.category}] ${fact.statement} ` +
        `(source: ${sourceLabel(fact)}; fact: ${fact.id})`,
    );
  }
  lines.push('', '## Open conflicts');
  if (conflicts.length === 0) lines.push('- None.');
  for (const conflict of conflicts) {
    lines.push(
      `- [${conflict.severity}/${conflict.kind}] ${conflict.claims.join(' | ')} ` +
        `(conflict: ${conflict.id})`,
    );
  }
  lines.push('', '## Known regressions');
  if (regressions.length === 0) lines.push('- None.');
  for (const regression of regressions) lines.push(`- ${regression}`);
  lines.push('', '## Required Nexus sensors');
  if (sensors.length === 0) lines.push('- None declared.');
  for (const sensor of sensors) lines.push(`- ${sensor}`);
  return lines.join('\n');
}

export function compileContextSnapshot(
  input: CompileContextSnapshotInput,
): ContextSnapshot {
  if (!input.goal.trim()) throw new Error('context snapshot goal is required');
  const domains = sortedUnique(input.impactedDomains);
  const symbols = sortedUnique(input.impactedSymbols);
  const required = new Set(input.requiredFactIds);
  const domainSet = new Set(domains);
  const symbolSet = new Set(symbols);
  const facts = input.facts
    .filter((fact) => fact.projectId === input.projectId)
    .filter((fact) => factRelevant(fact, required, domainSet, symbolSet))
    .sort((left, right) => {
      const requiredOrder = Number(required.has(right.id)) - Number(required.has(left.id));
      return requiredOrder || left.id.localeCompare(right.id);
    });
  const missing = [...required].filter((id) => !facts.some((fact) => fact.id === id));
  if (missing.length > 0) {
    throw new Error(`required context facts are missing: ${missing.join(', ')}`);
  }
  const conflicts = input.conflicts
    .filter(
      (conflict) =>
        conflict.affectedDomains.length === 0 ||
        conflict.affectedDomains.some((domain) => domainSet.has(domain)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const regressions = sortedUnique(input.regressions);
  const sensors = sortedUnique(input.requiredSensors);
  const maxCharacters = input.maxCharacters ?? 96_000;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1_024) {
    throw new Error('context snapshot maxCharacters is invalid');
  }

  let selected = [...facts];
  let markdown = renderSnapshot(
    input,
    selected,
    conflicts,
    domains,
    symbols,
    regressions,
    sensors,
  );
  while (markdown.length > maxCharacters && selected.length > required.size) {
    const removableIndex = [...selected]
      .map((fact, index) => ({ fact, index }))
      .reverse()
      .find(({ fact }) => !required.has(fact.id))?.index;
    if (removableIndex === undefined) break;
    selected.splice(removableIndex, 1);
    markdown = renderSnapshot(
      input,
      selected,
      conflicts,
      domains,
      symbols,
      regressions,
      sensors,
    );
  }
  if (markdown.length > maxCharacters) {
    throw new Error('required context exceeds the task capsule budget');
  }

  const payload = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    checkoutId: input.checkoutId,
    contextRevision: input.contextRevision,
    goal: input.goal.trim(),
    impactedDomains: domains,
    impactedSymbols: symbols,
    facts: selected.map((fact) => ({ id: fact.id, sourceHash: fact.sourceHash })),
    conflictIds: conflicts.map((conflict) => conflict.id),
    regressions,
    requiredSensors: sensors,
  };
  const contextHash = createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
  return Object.freeze({
    ...payload,
    impactedDomains: Object.freeze(domains),
    impactedSymbols: Object.freeze(symbols),
    factIds: Object.freeze(selected.map((fact) => fact.id)),
    conflictIds: Object.freeze(conflicts.map((conflict) => conflict.id)),
    regressions: Object.freeze(regressions),
    requiredSensors: Object.freeze(sensors),
    markdown,
    contextHash,
  });
}
