import { describe, expect, it } from 'vitest';
import { buildRouteSuccessIndex } from './route-pipeline';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { routeTask, isFrontierReviewer, type AdapterAvailability, type RouteContext } from './task-router';

const pool: AdapterAvailability[] = [
  { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] },
];
function choose(task: string, context: RouteContext & { reviewedFindingFix?: boolean } = {}) {
  return routeTask(task, pool, undefined, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: false, ...context });
}

describe('implementation cost policy from actual operator requests', () => {
  it.each([
    'Implemente a atualização automática das CLIs no macOS, Windows e Linux preservando os panes vivos',
    'Corrija o Kimi: o primeiro Enter é engolido e o kickoff precisa enviar o segundo sem duplicar o prompt',
  ])('prefers an eligible economic writer for %s', (task) => {
    const decision = choose(task)!;
    expect(decision).toMatchObject({ adapterId: 'glm', model: 'glm-5.3', tier: 'hard', effort: 'high' });
    expect(decision.reason).toContain('purpose=writer');
  });

  it('independent review still uses frontier judgment', () => {
    const decision = choose('Revise de forma independente o diff da correção do kickoff e dê o veredito')!;
    expect(isFrontierReviewer(decision.adapterId, decision.model)).toBe(true);
    expect(decision.adapterId).not.toBe('glm');
  });

  it('only Main-proved finding correction escalates the implementation purpose', () => {
    const task = 'Corrija o achado src/main/orch/tool-util.ts:653 sobre o segundo Enter';
    expect(choose(task)?.adapterId).toBe('glm');
    const proved = choose(task, { reviewedFindingFix: true })!;
    expect(isFrontierReviewer(proved.adapterId, proved.model)).toBe(true);
    expect(proved.reason).toContain('purpose=finding-fix');
  });

  it('does not override established worse handoff outcomes just to select a cheaper writer', () => {
    const decision = choose('Corrija o bug do kickoff Kimi', { routeOutcomes: buildRouteSuccessIndex([
      { adapterId: 'claude', model: 'claude-opus-5-5', successes: 9, total: 10 },
      { adapterId: 'glm', model: 'glm-5.3', successes: 2, total: 10 },
    ]) });
    expect(decision?.adapterId).toBe('claude');
  });

  it('preserves an explicit operator model choice while implementing', () => {
    expect(choose('Implemente a correção com o claude-opus-5-5')).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5' });
  });

  it('preserves the existing visual frontier policy', () => {
    const decision = choose('Implemente no grafo UI a direção horizontal, tela inteira e zoom legível')!;
    expect(decision.adapterId).toBe('claude');
    expect(isFrontierReviewer(decision.adapterId, decision.model)).toBe(true);
    expect(decision.reason).toContain('lane visual');
  });
});

describe('Astra remains an explicit or operator-approved visual choice', () => {
  const astraOnly = [{ id: 'codex', installed: true, models: ['gpt-6-astra'] }];
  it('does not inject Astra into automatic general code review', () => {
    const decision = routeTask('Revise o diff e dê o veredito', [...astraOnly, pool[1]!], undefined, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: false });
    expect(decision?.adapterId).toBe('glm');
    expect(decision?.judgeUnavailable).toBe(true);
  });
  it.each(['gpt-6-astra', 'gpt-6.2-astra'])('does not escape exclusion through the implicit CLI default: %s', (model) => {
    expect(routeTask('Implemente a atualização das CLIs', [{ ...astraOnly[0]!, models: [model] }], undefined, 'hard', false, BUILTIN_MODEL_CATALOG)).toBeNull();
  });
  it('cannot select a catalogue-only evaluated Astra model automatically', () => {
    // Synthetic quality metadata exercises eligibility, not model performance.
    const catalog = { version: 1, adapters: { codex: { models: [{ id: 'gpt-6-astra',
      availability: 'paid' as const, costTier: 'high' as const,
      quality: { overall: 80, coding: 80, source: 'nexus-eval/v1/published', evaluatedAt: '2026-10-05T00:00:00.000Z' },
    }] } } };
    expect(routeTask('Implemente a atualização das CLIs', astraOnly, undefined, 'hard', false, catalog)).toBeNull();
  });
  it('binds a safe known fallback model rather than leaving an Astra CLI default implicit', () => {
    const decision = routeTask('Implemente a atualização das CLIs', [{ id: 'codex', installed: true,
      models: ['gpt-6-astra', 'gpt-custom-workhorse'] }], undefined, 'hard', false, BUILTIN_MODEL_CATALOG);
    expect(decision?.model).toBe('gpt-custom-workhorse');
  });
  it.each([false, true])('safe fallback respects context even when Astra or another safe model is the only fit: %s', (hasSafeLarge) => {
    const models = ['gpt-safe-short', 'gpt-6-astra', ...(hasSafeLarge ? ['gpt-safe-large'] : [])];
    const catalog = { version: 1, adapters: { codex: { models: models.map(id => ({ id,
      availability: 'paid' as const, costTier: 'high' as const,
      maxContext: id === 'gpt-safe-short' ? 100_000 : 1_000_000,
    })) } } };
    const empty = { trivial: [], easy: [], medium: [], hard: [], critical: [] };
    const decision = routeTask('Implemente com 1M tokens of context', [{ id: 'codex', installed: true, models }], empty, 'hard', false, catalog);
    if (hasSafeLarge) expect(decision?.model).toBe('gpt-safe-large');
    else expect(decision).toBeNull();
  });
  it('retains an explicit Astra request under F-700', () => {
    expect(routeTask('Revise o diff com o GPT-6 Astra', astraOnly, undefined, 'hard', false, BUILTIN_MODEL_CATALOG)?.model).toBe('gpt-6-astra');
  });
  it('retains the current operator-authorized visual Astra exception', () => {
    expect(routeTask('Implemente o design da UI e os componentes visuais', astraOnly, undefined, 'hard', false, BUILTIN_MODEL_CATALOG)?.model).toBe('gpt-6-astra');
  });
});
