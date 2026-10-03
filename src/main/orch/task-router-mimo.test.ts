import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_TABLE, routeTask, type TaskTier } from './task-router';
import { routingOverridesFrom } from './jev-task-routing';

const flash = 'xiaomi/mimo-v2.6-flash';
const pro = 'xiaomi/mimo-v2.6-pro';
const ultra = 'xiaomi/mimo-v2.6-pro-ultraspeed';
const catalog = { version: 1 as const, adapters: {} };

describe('MiMo task routing', () => {
  it.each(['trivial', 'easy', 'medium'] satisfies TaskTier[])(
    'offers Flash for %s work without a benchmark score', (tier) => {
      const decision = routeTask('tarefa', [
        { id: 'mimo-code', installed: true, models: [flash, pro, ultra] },
      ], DEFAULT_ROUTING_TABLE, tier, false, catalog);
      expect(decision).toMatchObject({ adapterId: 'mimo-code', model: flash });
      expect(decision?.reason).not.toContain('nenhum candidato da tabela');
      expect(decision?.policySource).not.toBe('nexus-eval');
    },
  );

  it.each(['hard', 'critical'] satisfies TaskTier[])(
    'offers Pro for %s work and never the api-only Ultraspeed variant', (tier) => {
      const decision = routeTask('tarefa', [
        { id: 'mimo-code', installed: true, models: [flash, pro, ultra] },
      ], DEFAULT_ROUTING_TABLE, tier, false, catalog);
      expect(decision).toMatchObject({ adapterId: 'mimo-code', model: pro });
      // F-774: o ultraspeed saiu da tabela (api-only no catálogo e ausente da
      // CLI instalada) — não pode aparecer nem como alternativa.
      expect([decision, ...(decision?.alternatives ?? [])].some((row) => row?.model === ultra)).toBe(false);
    },
  );

  it('keeps MiMo eligible beside other installed providers and respects exact model availability', () => {
    const decision = routeTask('tarefa', [
      { id: 'codex', installed: true, models: ['gpt-5.4-mini'] },
      { id: 'mimo-code', installed: true, models: [flash] },
    ], DEFAULT_ROUTING_TABLE, 'easy', false, catalog);
    expect([decision, ...decision!.alternatives]).toContainEqual(expect.objectContaining({
      adapterId: 'mimo-code', model: flash,
    }));
    expect(decision?.alternatives.some((row) => row.model === pro || row.model === ultra)).toBe(false);
  });

  it('uses a confident Jev tier without asking Jev to invent model quality', () => {
    const overrides = routingOverridesFrom({
      tier: 'hard', tierConfidence: 0.9, specialty: 'general',
      specialtyConfidence: 0.9, escalate: 0.2, model: 'jev-test',
    }, undefined);
    const decision = routeTask('tarefa', [
      { id: 'mimo-code', installed: true, models: [flash, pro, ultra] },
    ], DEFAULT_ROUTING_TABLE, overrides.tierOverride, false, catalog, {
      specialtyOverride: overrides.specialtyOverride,
    });
    expect(decision).toMatchObject({ tier: 'hard', adapterId: 'mimo-code', model: pro });
  });
});
