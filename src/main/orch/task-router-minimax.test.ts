import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_TABLE, routeTask, type TaskTier } from './task-router';
import { routingOverridesFrom } from './jev-task-routing';

const highspeed = 'minimax/MiniMax-M2.7-highspeed';
const m3 = 'minimax/MiniMax-M3';
const flashPreview = 'minimax/MiniMax-M3.1-Flash-Preview';
const base = 'minimax/MiniMax-M2.7';
const models = [m3, flashPreview, highspeed, base];
const catalog = { version: 1 as const, adapters: {} };

describe('MiniMax task routing', () => {
  it.each(['trivial', 'easy'] satisfies TaskTier[])(
    'offers the highspeed lane for %s work without a benchmark score', (tier) => {
      const decision = routeTask('tarefa', [
        { id: 'minimax-code', installed: true, models },
      ], DEFAULT_ROUTING_TABLE, tier, false, catalog);
      expect(decision).toMatchObject({ adapterId: 'minimax-code', model: highspeed });
      expect(decision?.reason).not.toContain('nenhum candidato da tabela');
      expect(decision?.policySource).not.toBe('nexus-eval');
    },
  );

  it.each(['medium', 'hard', 'critical'] satisfies TaskTier[])(
    'offers M3 for %s work', (tier) => {
      const decision = routeTask('tarefa', [
        { id: 'minimax-code', installed: true, models },
      ], DEFAULT_ROUTING_TABLE, tier, false, catalog);
      expect(decision).toMatchObject({ adapterId: 'minimax-code', model: m3 });
    },
  );

  it('keeps MiniMax eligible beside other installed providers and respects exact model availability', () => {
    const decision = routeTask('tarefa', [
      { id: 'codex', installed: true, models: ['gpt-5.4-mini'] },
      { id: 'minimax-code', installed: true, models: [highspeed] },
    ], DEFAULT_ROUTING_TABLE, 'easy', false, catalog);
    expect([decision, ...decision!.alternatives]).toContainEqual(expect.objectContaining({
      adapterId: 'minimax-code', model: highspeed,
    }));
    expect(decision?.alternatives.some((row) => row.model === m3)).toBe(false);
  });

  it('uses a confident Jev tier without asking Jev to invent model quality', () => {
    const overrides = routingOverridesFrom({
      tier: 'hard', tierConfidence: 0.9, specialty: 'general',
      specialtyConfidence: 0.9, escalate: 0.2, model: 'jev-test',
    }, undefined);
    const decision = routeTask('tarefa', [
      { id: 'minimax-code', installed: true, models },
    ], DEFAULT_ROUTING_TABLE, overrides.tierOverride, false, catalog, {
      specialtyOverride: overrides.specialtyOverride,
    });
    expect(decision).toMatchObject({ tier: 'hard', adapterId: 'minimax-code', model: m3 });
  });
});
