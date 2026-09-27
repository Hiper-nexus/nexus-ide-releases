import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hasJevCredential: vi.fn(() => true),
}));

vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: h.hasJevCredential,
}));

import type { BrowserFindMatch } from '../../shared/browser-automation';
import type { JevResult } from '../jev/jev-client';
import {
  pickBrowserFindElement,
  selectFindTieBreakCandidates,
  FIND_JEV_MAX_SCORE_GAP,
  FIND_JEV_MIN_CONFIDENCE,
} from '../browser/browser-find-jev';

function match(
  ref: string,
  score: number,
  overrides: Partial<BrowserFindMatch> = {},
): BrowserFindMatch {
  return {
    ref,
    tag: 'button',
    role: 'button',
    name: ref,
    score,
    ...overrides,
  };
}

function jevResult(answers: JevResult['answers']): JevResult {
  return {
    model: 'jev-test',
    answers,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

const context = {
  query: 'Salvar',
  pageTitle: 'Formulário de pedido',
  url: 'https://example.test/form',
  sessionId: 's1',
  missionId: 'm1',
};

const ready = {
  jevEnabled: () => true,
  jevReady: () => true,
};

const deps = (result: JevResult | null) => ({
  ...ready,
  jev: vi.fn(async () => result),
  recordDecision: vi.fn(),
});

/** 2–5 candidatos com scores quase empatados. */
function ambiguousMatches(count = 3): BrowserFindMatch[] {
  return Array.from({ length: count }, (_, i) =>
    match(`e${i + 1}`, 0.9 - i * 0.02, { name: `Salvar ${i + 1}` }),
  );
}

describe('selectFindTieBreakCandidates', () => {
  it('1 candidato → sem Jev', () => {
    expect(selectFindTieBreakCandidates([match('e1', 0.9)])).toBeNull();
  });

  it('6+ candidatos → sem Jev', () => {
    expect(selectFindTieBreakCandidates(ambiguousMatches(6))).toBeNull();
  });

  it('2–5 com scores próximos → devolve o ranking ordenado', () => {
    const matches = ambiguousMatches(3);
    const selected = selectFindTieBreakCandidates(matches);
    expect(selected).not.toBeNull();
    expect(selected).toHaveLength(3);
    expect(selected![0]!.score).toBeGreaterThanOrEqual(selected![1]!.score);
  });

  it('top-2 com gap ≥ 0.15 já decide no lexical', () => {
    const matches = [
      match('e1', 0.95),
      match('e2', 0.95 - FIND_JEV_MAX_SCORE_GAP),
      match('e3', 0.5),
    ];
    expect(selectFindTieBreakCandidates(matches)).toBeNull();
  });

  it('menos de 2 candidatos com score ≥ 0.5 não vale o desempate', () => {
    const matches = [match('e1', 0.55), match('e2', 0.3), match('e3', 0.2)];
    expect(selectFindTieBreakCandidates(matches)).toBeNull();
  });
});

describe('pickBrowserFindElement', () => {
  it('1 candidato → sem chamada Jev', async () => {
    const d = deps(jevResult({}));
    expect(
      await pickBrowserFindElement([match('e1', 0.9)], context, d),
    ).toBeNull();
    expect(d.jev).not.toHaveBeenCalled();
    expect(d.recordDecision).not.toHaveBeenCalled();
  });

  it('6+ candidatos → sem chamada Jev', async () => {
    const d = deps(jevResult({}));
    expect(
      await pickBrowserFindElement(ambiguousMatches(6), context, d),
    ).toBeNull();
    expect(d.jev).not.toHaveBeenCalled();
  });

  it('2–5 ambíguos → picked com confiança 0.9 e diário browserTool', async () => {
    const matches = ambiguousMatches(3);
    const d = deps(
      jevResult({
        element: {
          type: 'choice',
          choice: 'e2',
          confidence: 0.9,
          probabilities: { e1: 0.05, e2: 0.9, e3: 0.02, none: 0.03 },
        },
      }),
    );
    const picked = await pickBrowserFindElement(matches, context, d);
    expect(picked).toEqual({ ref: 'e2', confidence: 0.9 });
    expect(d.jev).toHaveBeenCalledOnce();
    expect(d.jev).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 4_000, retryOnTimeout: false }),
    );
    expect(d.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'browserTool',
        questions: ['element'],
        decision: 'e2',
      }),
    );
  });

  it('confiança 0.5 → sem picked; ranking lexical e candidates mandam', async () => {
    const d = deps(
      jevResult({
        element: {
          type: 'choice',
          choice: 'e1',
          confidence: 0.5,
          probabilities: { e1: 0.5, e2: 0.3, e3: 0.1, none: 0.1 },
        },
      }),
    );
    expect(await pickBrowserFindElement(ambiguousMatches(3), context, d)).toBeNull();
    // Mesmo rejeitando, a consulta entra no diário (aprendizado do limiar).
    expect(d.recordDecision).toHaveBeenCalledOnce();
  });

  it('choice `none` → sem picked', async () => {
    const d = deps(
      jevResult({
        element: {
          type: 'choice',
          choice: 'none',
          confidence: 0.95,
          probabilities: { none: 0.95, e1: 0.02, e2: 0.02, e3: 0.01 },
        },
      }),
    );
    expect(await pickBrowserFindElement(ambiguousMatches(3), context, d)).toBeNull();
  });

  it('sem chave → lexical; judge não é consultado', async () => {
    h.hasJevCredential.mockReturnValueOnce(false);
    const d = deps(jevResult({}));
    // Sem jevReady injetado, o default (hasJevCredential mockado) manda.
    const picked = await pickBrowserFindElement(ambiguousMatches(3), context, {
      jev: d.jev,
      jevEnabled: () => true,
      recordDecision: d.recordDecision,
    });
    expect(picked).toBeNull();
    expect(d.jev).not.toHaveBeenCalled();
  });

  it('superfície browserTool off → fail-open lexical', async () => {
    const d = deps(jevResult({}));
    expect(
      await pickBrowserFindElement(ambiguousMatches(3), context, {
        jev: d.jev,
        jevEnabled: () => false,
        jevReady: () => true,
        recordDecision: d.recordDecision,
      }),
    ).toBeNull();
    expect(d.jev).not.toHaveBeenCalled();
  });

  it('judge() null → fail-open lexical', async () => {
    const d = deps(null);
    expect(await pickBrowserFindElement(ambiguousMatches(3), context, d)).toBeNull();
    expect(d.recordDecision).not.toHaveBeenCalled();
  });

  it('limiar de confiança é 0.7', () => {
    expect(FIND_JEV_MIN_CONFIDENCE).toBe(0.7);
  });
});
