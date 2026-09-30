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

// Lane visual (regra do operador, 30/09): UI/design sempre usa os modelos de
// topo — Opus 5.5 e Sonnet 5.5 lideram (superam até o Astra), depois Sol 6.1
// e Astra — e a rotação garantida NÃO os substitui por um provider sem assento.
describe('lane visual (modelos de topo para UI/design)', () => {
  const uiTask = 'criar a nova tela de onboarding com estados vazios e acessibilidade';

  it('tarefa visual vai para o primeiro da lane disponível', () => {
    const decision = routeTask(
      uiTask, adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision!.specialty).toBe('visual');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
    expect(decision!.reason).toContain('lane visual');
  });

  it('rotação não tira a tarefa visual da lane — reparte entre os de topo', () => {
    // codex já tem assento: fora da lane a rotação geral empurraria um
    // adapter barato sem assento; na lane visual o próximo é o membro de
    // topo menos usado — Opus 5.5 — e nunca sai dos modelos de topo.
    const decision = routeTask(
      uiTask, adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({ codex: 1, muse: 1 }),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
    expect(decision!.reason).toContain('lane visual');
    expect(decision!.reason).not.toContain('rotação garantida');
  });

  it('Astra entra pela lane quando é o único de topo disponível', () => {
    const onlyAstra: AdapterAvailability[] = [
      { id: 'claude', installed: true, models: ['claude-fable-5-1'] },
      { id: 'codex', installed: true, models: ['gpt-6-astra'] },
      { id: 'glm', installed: true, models: ['glm-5.3'] },
    ];
    const decision = routeTask(
      uiTask, onlyAstra, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6-astra');
    expect(decision!.reason).toContain('lane visual');
  });

  it('modelo citado no texto vence a lane', () => {
    const decision = routeTask(
      `${uiTask} — implemente com o glm-5.3`,
      adapters, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.3');
  });

  it('sem modelo da lane instalado, volta a mandar a rota normal', () => {
    const noLane = adapters.filter((a) => a.id !== 'claude' && a.id !== 'codex');
    const decision = routeTask(
      uiTask, noLane, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision!.specialty).toBe('visual');
    expect(decision!.reason).not.toContain('lane visual');
    expect(['glm', 'mimo-code', 'muse']).toContain(decision!.adapterId);
  });

  it('membro da lane promovido pela linha (id mais novo) mantém o assento', () => {
    // A CLI anuncia só o sucessor: opus-5-6 ≥ opus-5-5 na mesma linha.
    const newerOnly: AdapterAvailability[] = [
      { id: 'claude', installed: true, models: ['claude-opus-5-6'] },
      { id: 'glm', installed: true, models: ['glm-5.3'] },
    ];
    const decision = routeTask(
      uiTask, newerOnly, DEFAULT_ROUTING_TABLE, 'medium', false,
      undefined, context({}),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-6');
    expect(decision!.reason).toContain('lane visual');
  });
});

describe('guarda de tier da rotação', () => {
  it('task hard não rotaciona para candidato emprestado de tier mais fraco', () => {
    const withFlash: AdapterAvailability[] = [
      ...adapters,
      { id: 'glm-flash', installed: true, models: ['glm-5.3-flash[1m]'] },
    ];
    const decision = routeTask(
      'tarefa difícil qualquer', withFlash, DEFAULT_ROUTING_TABLE, 'hard', false,
      undefined,
      context({ claude: 1, codex: 1, glm: 1, 'mimo-code': 1, muse: 1 }),
    );
    // glm-flash é o único sem assento, mas sua entrada no hard é emprestada
    // de tier mais fraco — a rotação não pode derrubar o trabalho nele.
    expect(decision!.adapterId).not.toBe('glm-flash');
  });
});
