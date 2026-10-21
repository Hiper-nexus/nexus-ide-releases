import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, routeTask, type AdapterAvailability, type TaskTier } from './task-router';

// F-1621: ajuste visual trivial/easy segue a rota do tier ("barata escreve,
// ponta revisa"); construir tela (medium+) e Next/jogo seguem na lane de topo.
const ids = [...new Set(Object.values(DEFAULT_ROUTING_TABLE).flatMap((rows) => rows.map((row) => row.adapterId)))];
const everyone: AdapterAvailability[] = ids.map((id) => ({ id, installed: true }));
const route = (task: string, tier: TaskTier, missionUseCounts = new Map<string, number>()) => routeTask(
  task, everyone, DEFAULT_ROUTING_TABLE, tier, true, BUILTIN_MODEL_CATALOG, { multiScore: true, missionUseCounts },
)!;

const LIGHT_UI = 'mude a cor do link no rodapé';
const TOP_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'muse-wonder-full-1.0', 'gpt-6.1-sol', 'swe-2-high', 'gpt-6-astra']);

describe('F-1621: ajuste visual leve sai da lane de topo', () => {
  it.each<TaskTier>(['trivial', 'easy'])('%s visual não usa a lane nem esforço max', (tier) => {
    const decision = route(LIGHT_UI, tier);
    expect(decision.specialty).toBe('visual');
    expect(decision.reason).not.toContain('lane visual');
    expect(TOP_MODELS.has(decision.model ?? '')).toBe(false);
    expect(decision.effort).not.toBe('max');
  });

  it('dez ajustes visuais easy revezam entre as CLIs baratas, sem modelo de topo', () => {
    const uses = new Map<string, number>();
    const picks: string[] = [];
    for (let index = 0; index < 10; index++) {
      const decision = route(LIGHT_UI, 'easy', new Map(uses));
      uses.set(decision.adapterId, (uses.get(decision.adapterId) ?? 0) + 1);
      picks.push(`${decision.adapterId}:${decision.model}`);
      expect(TOP_MODELS.has(decision.model ?? '')).toBe(false);
    }
    expect(new Set(picks.map((pick) => pick.split(':')[0])).size).toBeGreaterThanOrEqual(5);
  });

  it('construir tela em medium continua na lane visual', () => {
    const decision = route('implementar a tela responsiva de cadastro com estados vazios', 'medium');
    expect(decision.reason).toContain('lane visual');
    expect(TOP_MODELS.has(decision.model ?? '')).toBe(true);
  });

  it('Next/jogo continua no topo mesmo em easy', () => {
    const decision = route('crie um jogo de navegador com phaser', 'easy');
    expect(decision.reason).toContain('lane visual');
    // Worker reserva o Claude para o Maestro: o topo disponível segue sendo topo.
    expect(TOP_MODELS.has(decision.model ?? '')).toBe(true);
  });
});
