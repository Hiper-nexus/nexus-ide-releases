import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  FAIR_SHARE_GAP,
  GLOBAL_USE_WINDOW_MS,
  routeTask,
  type AdapterAvailability,
} from './task-router';

// F-232 (regra do operador, 01/10): a rotação por missão sozinha só reparte
// assentos entre os primeiros do ranking (1–3 workers/missão). O fair-share
// GLOBAL usa reservas consumidas nos últimos 7 dias em todas as missões para
// dar a vez aos providers nunca escolhidos (medido: muse/grok/openclaude/
// minimax/deepseek com zero reservas).
const adapters: AdapterAvailability[] = [
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  {
    id: 'mimo-code',
    installed: true,
    models: ['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro'],
  },
  { id: 'muse', installed: true, models: ['muse-spark-1.3'] },
];

const context = (
  global: Record<string, number>,
  mission: Record<string, number> = {},
) => ({
  // multiScore desligado: a ordem da tabela fica crua e o efeito isolado do
  // fair-share é legível no resultado.
  multiScore: false,
  missionUseCounts: new Map(Object.entries(mission)),
  globalUseCounts: new Map(Object.entries(global)),
});

describe('fair-share global de rotas (F-232)', () => {
  it('exporta a janela de 7 dias e o gap anti-pingue-pongue', () => {
    expect(GLOBAL_USE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(FAIR_SHARE_GAP).toBe(2);
  });

  it('provider com zero reservas em 7d assume quando o líder passa do gap', () => {
    const decision = routeTask(
      'tarefa média qualquer',
      adapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      context({ glm: 9, 'mimo-code': 7, muse: 0 }),
    );
    expect(decision).not.toBeNull();
    expect(decision!.adapterId).toBe('muse');
    expect(decision!.reason).toContain('fair-share');
  });

  it('F-238: qwen instalado com zero reservas pode assumir o medium', () => {
    const withQwen: AdapterAvailability[] = [
      ...adapters,
      { id: 'qwen', installed: true, models: ['qwen3.8-max'] },
    ];
    const decision = routeTask(
      'tarefa média qualquer',
      withQwen,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      context({ glm: 9, 'mimo-code': 7, muse: 0, qwen: 0 }),
    );
    expect(decision).not.toBeNull();
    expect(['muse', 'qwen']).toContain(decision!.adapterId);
    expect(decision!.reason).toContain('fair-share');
  });

  it('gap abaixo do limiar mantém o líder (sem pingue-pongue)', () => {
    const decision = routeTask(
      'tarefa média qualquer',
      adapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      context({ glm: 1, 'mimo-code': 0, muse: 0 }),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('fair-share');
  });

  it('tier critical ignora o fair-share mesmo com gap enorme', () => {
    const frontierAdapters: AdapterAvailability[] = [
      {
        id: 'claude',
        installed: true,
        models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],
      },
      { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-astra'] },
      { id: 'glm', installed: true, models: ['glm-5.3'] },
    ];
    const decision = routeTask(
      'corrigir falha de autenticação crítica em produção',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      'critical',
      false,
      undefined,
      context({ claude: 99, glm: 0 }),
    );
    expect(decision!.reason).not.toContain('fair-share');
    expect(decision!.adapterId).not.toBe('glm');
  });

  it('especialidade visual ignora o fair-share — a lane de topo manda', () => {
    const frontierAdapters: AdapterAvailability[] = [
      {
        id: 'claude',
        installed: true,
        models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      },
      { id: 'glm', installed: true, models: ['glm-5.3'] },
      { id: 'muse', installed: true, models: ['muse-spark-1.3'] },
    ];
    const decision = routeTask(
      'criar a nova tela de onboarding com estados vazios e acessibilidade',
      frontierAdapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      context({ claude: 50, glm: 0, muse: 0 }),
    );
    expect(decision!.specialty).toBe('visual');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.reason).toContain('lane visual');
    expect(decision!.reason).not.toContain('fair-share');
  });

  it('rotação por missão vence — o fair-share não mexe no assento fresco', () => {
    const decision = routeTask(
      'tarefa média qualquer',
      adapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      context({ glm: 9, 'mimo-code': 0, muse: 0 }, { glm: 1 }),
    );
    // glm já tem assento na missão: a rotação promove o primeiro fresco
    // (mimo-code, antes do muse na tabela) e o fair-share não interfere.
    expect(decision!.adapterId).toBe('mimo-code');
    expect(decision!.reason).toContain('rotação garantida');
    expect(decision!.reason).not.toContain('fair-share');
  });

  it('sem globalUseCounts (rota livre, sem missão) o líder segue a tabela', () => {
    const decision = routeTask(
      'tarefa média qualquer',
      adapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      undefined,
      { multiScore: false },
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('fair-share');
  });
});
