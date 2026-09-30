import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
} from './task-router';

// Rotação garantida por missão (regra do operador, 29/09): cada adapter
// elegível recebe um assento antes de qualquer repetição. Sem ela, um provider
// com nota alta dominava a missão inteira quando o rerank era desligado
// (multiScore:false) ou quando o gap de qualidade excedia a penalidade de uso.
const adapters: AdapterAvailability[] = [
  { id: 'claude', installed: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'] },
  { id: 'codex', installed: true, models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol'] },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'] },
  { id: 'muse', installed: true, models: ['muse-spark-1.3'] },
];

const context = (used: Record<string, number>) => ({
  multiScore: true,
  missionUseCounts: new Map(Object.entries(used)),
});

describe('rotação garantida por missão (usar todas as LLMs)', () => {
  it('primeiro assento segue a melhor rota normal', () => {
    const decision = routeTask(
      'tarefa média qualquer', adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision).not.toBeNull();
    expect(decision!.reason).not.toContain('rotação garantida');
  });

  it('com tabela crua (sem multi-score) um provider sem assento é promovido', () => {
    // multiScore:false preserva a ordem da tabela — glm lidera medium mesmo
    // já usado; a rotação promove o primeiro adapter ainda sem assento.
    const decision = routeTask(
      'tarefa média qualquer', adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, { multiScore: false, missionUseCounts: new Map([['glm', 1]]) },
    );
    expect(decision!.adapterId).not.toBe('glm');
    expect(decision!.reason).toContain('rotação garantida');
  });

  it('depois que todos têm assento, volta a mandar a pontuação', () => {
    const decision = routeTask(
      'tarefa média qualquer', adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined,
      context({ glm: 1, codex: 1, 'mimo-code': 1, muse: 1, claude: 1 }),
    );
    expect(decision!.reason).not.toContain('rotação garantida');
  });

  it('critical não rotaciona — o topo entre CLIs continua mandando', () => {
    const decision = routeTask(
      'corrigir falha de autenticação crítica', adapters, DEFAULT_ROUTING_TABLE, 'critical', false,
      undefined, context({ claude: 2, codex: 1 }),
    );
    expect(['claude', 'codex', 'glm']).toContain(decision!.adapterId);
    expect(decision!.adapterId).not.toBe('muse');
    expect(decision!.adapterId).not.toBe('mimo-code');
  });

  it('modelo citado no texto vence a rotação', () => {
    const decision = routeTask(
      'implemente com o claude-opus-5-5', adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({ claude: 1 }),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
  });

  it('adapter sem candidato elegível não entra na rotação', () => {
    const withoutMuse = adapters.filter((a) => a.id !== 'muse');
    const decision = routeTask(
      'tarefa média qualquer', withoutMuse, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({ glm: 1, codex: 1, 'mimo-code': 1 }),
    );
    // claude é o único ainda sem assento — a rotação o promove.
    expect(decision!.adapterId).toBe('claude');
  });
});
