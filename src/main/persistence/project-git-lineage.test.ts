import { describe, expect, it } from 'vitest';
import { compareRepositoryLineage } from './project-git-lineage';
import type { GitRepositoryLineage } from '../../shared/project-identity-types';
import type { GitRepositoryProof } from './project-git-lineage';

const ANCHOR = 'a'.repeat(40);
const ROOT = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

function lineage(overrides: Partial<GitRepositoryLineage> = {}): GitRepositoryLineage {
  return {
    vcs: 'git',
    originHashes: ['origin-sha256-antigo'],
    rootCommits: [ROOT],
    anchorCommits: [ANCHOR],
    ...overrides,
  };
}

function proof(overrides: Partial<GitRepositoryProof> = {}): GitRepositoryProof {
  return {
    isShallow: false,
    originHashes: ['origin-sha256-novo'],
    rootCommits: [ROOT],
    headCommit: HEAD,
    ...overrides,
  };
}

describe('compareRepositoryLineage', () => {
  it('rename de repo: origin mudou mas anchor alcançável → mesmo projeto', () => {
    // Caso de campo 20/08: cleofasvolarehost/nexus-ide → Hiper-nexus/nexus-ide
    // brickou TODA abertura de workspace. A história (anchor) é a prova mais
    // forte que a URL — um manifesto copiado pra repo alheio nunca tem o
    // anchor alcançável.
    const result = compareRepositoryLineage(lineage(), proof(), () => true);
    expect(result).toEqual({ ok: true });
  });

  it('manifesto copiado: origin mudou E anchor inalcançável → quarentena', () => {
    const result = compareRepositoryLineage(lineage(), proof(), () => false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('shallow não consegue provar anchor → origin divergente falha fechado', () => {
    const result = compareRepositoryLineage(
      lineage(),
      proof({ isShallow: true }),
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('origin igual + anchor alcançável → ok', () => {
    const result = compareRepositoryLineage(
      lineage({ originHashes: ['origin-sha256-igual'] }),
      proof({ originHashes: ['origin-sha256-igual'] }),
      () => true,
    );
    expect(result).toEqual({ ok: true });
  });

  it('origin igual mas anchor inalcançável → quarentena (anchor manda)', () => {
    const result = compareRepositoryLineage(
      lineage({ originHashes: ['origin-sha256-igual'] }),
      proof({ originHashes: ['origin-sha256-igual'] }),
      () => false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('sem anchors no manifesto: origin divergente continua quarentenando', () => {
    const result = compareRepositoryLineage(
      lineage({ anchorCommits: [] }),
      proof(),
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('anchors presentes mas sem verificador → unverifiable, nunca ok', () => {
    const result = compareRepositoryLineage(lineage(), proof());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unverifiable');
  });
});
