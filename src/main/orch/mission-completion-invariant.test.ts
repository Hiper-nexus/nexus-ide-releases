import { describe, expect, it } from 'vitest';
import {
  countPlannedPendingDispatches,
  decideDriveAction,
  defaultDriveConfig,
  deriveDriveState,
  isDispatchWorkProven,
  type DriveStateInputs,
} from './mission-drive';

/**
 * LÁPIDE DA CLASSE "todo o trabalho pronto, nada conclui".
 *
 * Mordeu o dono DUAS VEZES em dois dias com dois nomes diferentes: primeiro
 * como `handoff_ready` estacionado, depois — no gate da 0.28.0 — como missão com
 * 8/8 dispatches `completed`, `last_error: null`, presa em `running` para sempre
 * com o driver decidindo `wait` em todo tick (`attempt_count: 0`).
 *
 * A causa foi sempre a mesma: a conclusão era lida de um artefato de CERIMÔNIA
 * (milestone carimbado, recibo PREVC) em vez do TRABALHO. Quando `same_checkout`
 * virou o caminho padrão, a cerimônia que carimbava o step deixou de existir e
 * levou junto o batimento que o driver observava.
 *
 * O invariante abaixo não admite condição, sinal de prontidão, humano nem timer:
 * **todo dispatch concluído e comprovado ⇒ a missão alcança estado terminal por
 * si só.** Se este teste ficar vermelho, a doença voltou.
 */
describe('invariante de conclusão: o trabalho manda, não a cerimônia', () => {
  const config = defaultDriveConfig;

  /**
   * `now` logo depois do último progresso: os casos de "ainda em curso" testam a
   * decisão de conclusão, não o detector de stall — deixar o relógio correr
   * meses fazia o stall responder antes e mascarar o que está sob teste.
   */
  const AGORA = 1_786_054_408_000;

  /** Reprodução literal do estado observado no gate da 0.28.0. */
  const missaoDoGate: DriveStateInputs['mission'] = {
    id: 'mission-df94ef60',
    status: 'running',
    updatedAt: 1_786_054_407_000,
    createdAt: 1_786_053_785_850,
    // O milestone NUNCA foi carimbado — o caminho simples não o carimba.
    milestones: [{ id: 'step-1', label: 'Entrega', status: 'pending', evidenceIds: [] }],
  };

  it('8/8 dispatches concluídos e comprovados ⇒ missão COMPLETA, mesmo com milestone pendente', () => {
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: { total: 8, completed: 8, receipted: 8 },
    });

    const action = decideDriveAction(state, Date.now(), config);

    // Antes do fix isto era `wait` para sempre — a missão do dono nunca fechava.
    expect(action.kind).toBe('complete');
  });

  it('trabalho concluído SEM recibo não é silêncio: vira parada visível com motivo', () => {
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: { total: 8, completed: 8, receipted: 6 },
    });

    const action = decideDriveAction(state, Date.now(), config);

    // Nunca `wait`: um driver que não consegue progredir com o trabalho todo
    // pronto TEM de aparecer, com razão legível. Degenerar em silêncio foi o
    // que fez o dono olhar uma tela parada sem saber de nada.
    expect(action.kind).not.toBe('wait');
    expect(action.reason).toMatch(/recibo|comprova/i);
  });

  it('trabalho ainda em curso continua esperando — o invariante não força conclusão', () => {
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: { total: 8, completed: 5, receipted: 5 },
    });

    expect(decideDriveAction(state, AGORA, config).kind).toBe('wait');
  });

  it('missão sem dispatch nenhum não é "tudo pronto" — zero trabalho não é trabalho feito', () => {
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: { total: 0, completed: 0, receipted: 0 },
    });

    expect(decideDriveAction(state, Date.now(), config).kind).not.toBe('complete');
  });

  it('sem instrumentação de fila o comportamento antigo permanece — nada é fabricado', () => {
    const state = deriveDriveState({ mission: missaoDoGate, handoffs: [] });
    expect(decideDriveAction(state, AGORA, config).kind).toBe('wait');
  });

  it('1 dispatch completo com plano de 3 tasks ainda pendentes NÃO fecha a missão (HiperGO 07/08)', () => {
    // Reprodução: onda 1 (executor) completed+receipted; ondas 2/3 (reviewer/QA)
    // ainda no plano sem dispatch. O driver antigo lia total=1 e marcava done.
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: {
        total: 1,
        completed: 1,
        receipted: 1,
        plannedPending: 2,
      },
    });

    const action = decideDriveAction(state, AGORA, config);
    expect(action.kind).not.toBe('complete');
    expect(isDispatchWorkProven({
      total: 1,
      completed: 1,
      receipted: 1,
      plannedPending: 2,
    })).toBe(false);
  });

  it('plano selado esgotado (plannedPending=0) com fila receipted ⇒ complete', () => {
    const state = deriveDriveState({
      mission: missaoDoGate,
      handoffs: [],
      dispatchWork: {
        total: 3,
        completed: 3,
        receipted: 3,
        plannedPending: 0,
      },
    });
    expect(decideDriveAction(state, Date.now(), config).kind).toBe('complete');
  });
});

/**
 * A METADE QUE QUASE ESCAPOU.
 *
 * Decidir `complete` não basta: o lado APLICAR (`completeMission` em
 * mission-driver-io.ts) tinha os MESMOS proxies de cerimônia e teria rejeitado
 * a decisão em todo tick — "espera para sempre" viraria "decide e lança", a
 * terceira roupa da mesma doença no mesmo dia.
 *
 * O invariante completo tem duas pernas, e um teste que cobrisse só a decisão
 * teria passado verde com o produto quebrado:
 *   1. com todo o trabalho provado, a decisão é `complete`;
 *   2. e o aplicar ACEITA essa conclusão.
 */
describe('invariante de conclusão: decidir e APLICAR são a mesma promessa', () => {
  const provas = [
    { rotulo: 'concluído com recibo', state: 'completed', receipt: {}, aceita: true },
    { rotulo: 'concluído sem recibo', state: 'completed', receipt: null, aceita: false },
    { rotulo: 'ainda em execução', state: 'running', receipt: {}, aceita: false },
  ] as const;

  it.each(provas)(
    'a regra do aplicar bate com a da decisão: $rotulo',
    ({ state, receipt, aceita }) => {
      // Mesmo predicado canônico usado por decide e apply.
      const dispatches = [
        {
          taskId: 'task-1',
          state,
          integrationReceipt: receipt,
        },
      ];
      const completed = dispatches.filter((d) => d.state === 'completed').length;
      const receipted = dispatches.filter(
        (d) => d.state === 'completed' && d.integrationReceipt != null,
      ).length;
      const workProven = isDispatchWorkProven({
        total: dispatches.length,
        completed,
        receipted,
        plannedPending: 0,
      });
      expect(workProven).toBe(aceita);
    },
  );

  it('missão sem dispatch nenhum nunca é "trabalho provado" nos dois lados', () => {
    expect(
      isDispatchWorkProven({ total: 0, completed: 0, receipted: 0 }),
    ).toBe(false);
  });

  it('aplicar e decidir recusam complete com residual de plano (mesma moeda)', () => {
    const dispatches = [
      {
        taskId: 'task-executor',
        state: 'completed',
        integrationReceipt: {},
      },
    ];
    const plannedPending = countPlannedPendingDispatches(
      ['task-executor', 'task-reviewer', 'task-qa'],
      dispatches,
    );
    expect(plannedPending).toBe(2);
    expect(
      isDispatchWorkProven({
        total: 1,
        completed: 1,
        receipted: 1,
        plannedPending,
      }),
    ).toBe(false);
  });
});
