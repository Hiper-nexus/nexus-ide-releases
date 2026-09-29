import { describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import { pinUniqueSealedRosterOnDecision } from '../../shared/sealed-agent-runtime';
import { buildControlArgs } from '../adapters/control-args';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { routeTask, type AdapterAvailability, type TaskTier } from './task-router';

const supported = ['low', 'medium', 'high', 'xhigh'];
const builtins = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));
const codex: AdapterAvailability = {
  id: 'codex', installed: true,
  // Só o modelo da tabela hard resolve: para trivial/easy/medium a decisão
  // precisa pegar emprestado o gpt-5.6-sol, mantendo o contrato do F-163
  // (o esforço é da tarefa, não do tier de onde o modelo veio).
  models: ['gpt-5.6-sol'],
  efforts: supported,
};

describe('task effort survives model selection (F-163)', () => {
  it.each([
    ['trivial', 'low'], ['easy', 'low'], ['medium', 'medium'],
    ['hard', 'high'], ['critical', 'xhigh'],
  ] as const)('%s bug uses its task effort, even when the model comes from hard', (tier, effort) => {
    const decision = routeTask('Fix the reported behavior', [codex], undefined, tier,
      false, BUILTIN_MODEL_CATALOG, { specialtyOverride: 'bug' });
    expect(decision).toMatchObject({ tier, effort, model: 'gpt-5.6-sol' });
    expect(decision!.alternatives.every((candidate) => candidate.effort === effort)).toBe(true);
  });

  it('critical work keeps its effort when only a cheaper-tier model is installed', () => {
    // LongCat só está na tabela `hard` (ausente de `critical`) — grok deixou
    // de servir este caso depois que o catálogo unificou seus modelos no
    // grok-4.7 vigente (xAI aposentou o restante da linhagem, 2026-09-27).
    const decision = routeTask('Repair recovery', [{
      id: 'longcat', installed: true, models: ['LongCat-2.0'], efforts: supported,
    }], undefined, 'critical', false, BUILTIN_MODEL_CATALOG);
    expect(decision).toMatchObject({ model: 'LongCat-2.0', effort: 'xhigh' });
  });

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'independent Jev effort %s wins over security specialty, tier and benchmark',
    (effort) => {
      const decision = routeTask('Inspect an auth setting', [codex], undefined, 'critical',
        false, BUILTIN_MODEL_CATALOG, {
          specialtyOverride: 'security', effortOverride: effort,
          specialtyBenchmark: { schemaVersion: 1, source: 'nexus-benchmark/v1',
            specialties: { security: [{ adapterId: 'codex', effort: 'xhigh', score: 95 }] } },
        });
      expect(decision!.effort).toBe(effort);
      expect(decision!.alternatives.every((candidate) => candidate.effort === effort)).toBe(true);
    },
  );

  it('a human-sealed mission roster still wins over automatic effort', () => {
    const decision = routeTask('Inspect', [codex], undefined, 'easy', false,
      BUILTIN_MODEL_CATALOG, { effortOverride: 'low' })!;
    expect(pinUniqueSealedRosterOnDecision(decision, [{
      cli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh',
    }])).toMatchObject({ model: 'gpt-5.6-sol', effort: 'xhigh' });
  });

  it('normalizes every alternative before a caller can spawn it', () => {
    const pool = [codex, ...['agy', 'kimi', 'mimo-code'].map((id) => {
      const adapter = builtins.find((a) => a.id === id)!;
      return { id, installed: true, models: adapter.models.list,
        efforts: adapter.kind === 'cli-pty' ? adapter.control?.effort?.levels ?? [] : [] };
    })];
    const decision = routeTask('Task', pool, undefined, 'critical', false,
      BUILTIN_MODEL_CATALOG, { effortOverride: 'xhigh' })!;
    for (const candidate of [decision, ...decision.alternatives]) {
      const adapter = builtins.find((a) => a.id === candidate.adapterId)!;
      if (adapter.kind !== 'cli-pty') throw new Error('expected CLI');
      const args = buildControlArgs(adapter, { effort: candidate.effort });
      if (candidate.adapterId === 'agy') {
        expect(candidate.effort).toBe('high');
        expect(args).toContain('high');
      } else if (candidate.adapterId === 'codex') {
        expect(candidate.effort).toBe('xhigh');
        expect(args).toContain('model_reasoning_effort=xhigh');
      } else {
        expect(candidate.effort).toBeUndefined();
        expect(args.some((arg) => /effort|reasoning/.test(arg))).toBe(false);
      }
    }
  });

  it.each(['trivial', 'medium', 'critical'] as TaskTier[])(
    'fallback CLI without effort control does not invent a value at tier %s',
    (tier) => {
      expect(routeTask('Task', [{ id: 'future-cli', installed: true, efforts: [] }],
        undefined, tier, false, BUILTIN_MODEL_CATALOG)!.effort).toBeUndefined();
    },
  );
});
