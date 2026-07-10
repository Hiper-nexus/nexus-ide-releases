import type {
  ContextCandidate,
  ContextClaimValue,
  ContextFact,
  ContextFactCategory,
  ContextFactKind,
  ProjectContextCorpus,
} from './context-types';

export interface CandidateValidation {
  readonly validatorId: string;
  readonly kind: Exclude<ContextFactKind, 'conflict' | 'deprecated'>;
  readonly claimKey: string;
  readonly value: ContextClaimValue;
  readonly category: ContextFactCategory;
  readonly domains?: readonly string[];
  readonly relatedSymbols?: readonly string[];
  readonly confidence?: number;
  readonly validFrom?: string;
}

function cloneFact(fact: ContextFact): ContextFact {
  return Object.freeze({
    ...fact,
    source: Object.freeze({ ...fact.source }),
    domains: Object.freeze([...fact.domains]),
    relatedSymbols: Object.freeze([...fact.relatedSymbols]),
    supersedes: fact.supersedes ? Object.freeze([...fact.supersedes]) : undefined,
    value: Array.isArray(fact.value) ? Object.freeze([...fact.value]) : fact.value,
  });
}

function cloneCandidate(candidate: ContextCandidate): ContextCandidate {
  return Object.freeze({
    ...candidate,
    source: Object.freeze({ ...candidate.source }),
    domains: Object.freeze([...candidate.domains]),
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Canonical in-memory graph model. Persistence/indexes are derived layers;
 * every returned node retains its immutable source binding.
 */
export class TruthGraph {
  readonly projectId: string;
  readonly contextRevision: string;
  readonly #facts = new Map<string, ContextFact>();
  readonly #candidates = new Map<string, ContextCandidate>();

  constructor(corpus: ProjectContextCorpus) {
    this.projectId = corpus.projectId;
    this.contextRevision = corpus.contextRevision;
    for (const candidate of corpus.candidates) {
      this.#candidates.set(candidate.id, cloneCandidate(candidate));
    }
    for (const fact of corpus.facts) this.addFact(fact);
  }

  addFact(rawFact: ContextFact): ContextFact {
    if (rawFact.projectId !== this.projectId) {
      throw new Error('context fact belongs to another project');
    }
    if (this.#facts.has(rawFact.id)) throw new Error(`duplicate context fact: ${rawFact.id}`);
    if (!/^[a-f0-9]{64}$/i.test(rawFact.sourceHash)) {
      throw new Error(`context fact has invalid source hash: ${rawFact.id}`);
    }
    if (rawFact.confidence < 0 || rawFact.confidence > 1) {
      throw new Error(`context fact has invalid confidence: ${rawFact.id}`);
    }
    const fact = cloneFact(rawFact);
    this.#facts.set(fact.id, fact);
    return cloneFact(fact);
  }

  promoteCandidate(
    candidateId: string,
    validation: CandidateValidation,
  ): ContextFact {
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) throw new Error(`unknown context candidate: ${candidateId}`);
    if (validation.validatorId === candidate.producerId) {
      throw new Error('context promotion requires an independent validator');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(validation.claimKey)) {
      throw new Error('invalid promoted claim key');
    }
    const fact: ContextFact = {
      id: `fact:${candidate.id.slice('candidate:'.length)}`,
      projectId: candidate.projectId,
      statement: candidate.statement,
      claimKey: validation.claimKey,
      value: validation.value,
      kind: validation.kind,
      category: validation.category,
      source: candidate.source,
      sourceHash: candidate.sourceHash,
      domains: sortedUnique(validation.domains ?? candidate.domains),
      relatedSymbols: sortedUnique(validation.relatedSymbols ?? []),
      confidence: validation.confidence ?? 1,
      validFrom: validation.validFrom ?? '1970-01-01T00:00:00.000Z',
    };
    return this.addFact(fact);
  }

  getFact(id: string): ContextFact | null {
    const fact = this.#facts.get(id);
    return fact ? cloneFact(fact) : null;
  }

  listFacts(): readonly ContextFact[] {
    return Object.freeze(
      [...this.#facts.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneFact),
    );
  }

  query(input: {
    domains?: readonly string[];
    symbols?: readonly string[];
    categories?: readonly ContextFactCategory[];
  }): readonly ContextFact[] {
    const domains = new Set(input.domains ?? []);
    const symbols = new Set(input.symbols ?? []);
    const categories = new Set(input.categories ?? []);
    return Object.freeze(
      this.listFacts().filter((fact) => {
        if (categories.size > 0 && !categories.has(fact.category)) return false;
        if (
          domains.size > 0 &&
          !fact.domains.some((domain) => domains.has(domain))
        ) {
          return false;
        }
        if (
          symbols.size > 0 &&
          !fact.relatedSymbols.some((symbol) => symbols.has(symbol))
        ) {
          return false;
        }
        return true;
      }),
    );
  }
}
