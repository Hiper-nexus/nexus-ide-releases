import { describe, expect, it } from 'vitest';
import type { DesignKitSummary } from './design-kit-source';
import {
  scoreDesignKitsAgainstGoal,
  selectDesignDirection,
} from './design-kit-selection';

function kit(
  kitId: string,
  description: string,
  tags: readonly string[] = [],
): DesignKitSummary {
  return Object.freeze({
    sourceId: 'local-catalog' as const,
    kitId,
    title: `${kitId} design analysis`,
    description,
    tags: Object.freeze([...tags]),
    license: 'unknown',
    locator: `${kitId}.md`,
  });
}

/**
 * Descriptions abridged from the real `~/.design-references` catalog so the
 * suite exercises the same text the rule meets in production, without reading
 * the developer's home directory.
 */
const CATALOG: readonly DesignKitSummary[] = Object.freeze([
  kit(
    'stripe',
    'A financial-infrastructure brand built on a deep navy ink and an electric indigo primary, with tabular figures where money and numerics matter, and a dashboard track that flips polarity.',
  ),
  kit(
    'supabase',
    'An open-source database platform on a clean white-and-near-black system with a single emerald CTA. Quietly technical: minimal chrome and dense product UI mockups.',
  ),
  kit(
    'notion',
    'The all-in-one workspace: illustration-rich brand voice, a purple pill CTA, and pastel feature cards echoing the live docs product.',
  ),
  kit(
    'apple',
    'A photography-first interface that turns marketing into a museum gallery. Edge-to-edge product tiles and a single Action Blue interactive color.',
  ),
]);

describe('selectDesignDirection', () => {
  it('lets an explicit setting win over a goal that matches another kit', () => {
    // The goal screams fintech; the operator pinned the docs kit anyway.
    const choice = selectDesignDirection({
      goal: 'construir o checkout de pagamentos da fintech',
      pinnedKitId: 'notion',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('setting');
    expect(choice.mode === 'setting' && choice.kit.kitId).toBe('notion');
  });

  it('falls to neutral — never to a near miss — when the pinned kit is absent', () => {
    const choice = selectDesignDirection({
      goal: 'construir o checkout de pagamentos da fintech',
      pinnedKitId: 'mercury',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('neutral');
    expect(choice.mode === 'neutral' && choice.reason).toBe(
      'pinned-kit-unavailable',
    );
  });

  it('matches a distinctive domain to exactly one kit with high confidence', () => {
    const choice = selectDesignDirection({
      goal: 'criar a landing page de marketing do produto de pagamentos da fintech',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('match');
    if (choice.mode !== 'match') throw new Error('expected a match');
    expect(choice.kit.kitId).toBe('stripe');
    expect([...choice.sharedAxes].sort()).toEqual(['fintech', 'marketing']);
    expect(choice.confidence).toBe('high');
  });

  it('reports low confidence when a single axis decided the match', () => {
    const choice = selectDesignDirection({
      goal: 'redesign da tela de checkout de pagamentos',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('match');
    if (choice.mode !== 'match') throw new Error('expected a match');
    expect(choice.kit.kitId).toBe('stripe');
    expect(choice.confidence).toBe('low');
  });

  it('refuses to break a tie: two equally matched kits produce the neutral contract', () => {
    // "marketing" fires for apple and for stripe. A coin flip here is exactly
    // how a project ends up wearing a famous brand by accident.
    const choice = selectDesignDirection({
      goal: 'redesign da landing page de marketing institucional',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('neutral');
    expect(choice.mode === 'neutral' && choice.reason).toBe('ambiguous-match');
  });

  it('stays neutral for a goal that names no product domain', () => {
    const choice = selectDesignDirection({
      goal: 'redesign da tela de configuracoes do aplicativo',
      kits: CATALOG,
    });

    expect(choice.mode).toBe('neutral');
    expect(choice.mode === 'neutral' && choice.reason).toBe('no-domain-signal');
  });

  it('stays neutral when the catalog is empty', () => {
    const choice = selectDesignDirection({
      goal: 'criar o dashboard de metricas do admin',
      kits: [],
    });

    expect(choice.mode).toBe('neutral');
    expect(choice.mode === 'neutral' && choice.reason).toBe('empty-catalog');
  });

  it('never scores a kit on generic UI words alone', () => {
    // Every kit talks about colour, type and layout. If those counted, every
    // goal would "match" whichever brand happened to sort first.
    const scores = scoreDesignKitsAgainstGoal(
      'ajustar o layout, as cores e a tipografia dos botoes',
      CATALOG,
    );

    expect(scores.every((score) => score.score === 0)).toBe(true);
  });

  it('does not read "banco de dados" as a bank and hand a database project a payments brand', () => {
    const goal = 'criar a interface do dev tool de banco de dados';

    // The regression: `banco` used to fire the fintech axis, so this goal
    // scored stripe 2 (fintech + "financial-infrastructure") and imported a
    // payments identity into a database tool.
    const stripeScore = scoreDesignKitsAgainstGoal(goal, CATALOG).find(
      (score) => score.kitId === 'stripe',
    );
    expect(stripeScore?.score).toBe(0);

    const choice = selectDesignDirection({ goal, kits: CATALOG });
    expect(choice.mode).toBe('match');
    if (choice.mode !== 'match') throw new Error('expected a match');
    expect(choice.kit.kitId).toBe('supabase');
    expect(choice.sharedAxes).toEqual(['devtool']);
  });

  it('is deterministic: the same inputs always produce the same choice', () => {
    const goal = 'criar o dashboard de metricas do banco de dados';
    const first = selectDesignDirection({ goal, kits: CATALOG });
    const second = selectDesignDirection({ goal, kits: CATALOG });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
