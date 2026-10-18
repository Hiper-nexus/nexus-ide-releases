import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionPaneSpec } from '../../shared/orch-types';

const traceMock = vi.hoisted(() => vi.fn());
vi.mock('../observability/main-trace', () => ({ trace: traceMock }));

import {
  OPERATOR_TAB_RESUME_LOST_NOTE,
  OPERATOR_TAB_RESUME_NOTE,
  buildOrphanedDispatchTaskNote,
  listOrphanedDispatchTasks,
  planOperatorTabResume,
  OPERATOR_TAB_RESUME_TRANSFER_TTL_MS,
  beginOperatorTabResumeTransfer,
  isOperatorTabResumeTransferSource,
  operatorTabMissionResumeSpec,
  operatorTabResumeAgent,
  operatorTabResumeAwaitsAdjustment,
  operatorTabResumeTransferInFlight,
  resetOperatorTabResumeTransfersForTests,
} from './operator-tab-mission-resume';

const tabMission = {
  squadId: undefined,
  intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
} as unknown as Pick<Mission, 'squadId' | 'intentContract'>;

function spec(paneId: string, role: 'orchestrator' | 'worker', extra: Partial<MissionPaneSpec> = {}): MissionPaneSpec {
  return { id: `mp-${paneId}`, missionId: 'm', paneId, adapterId: 'claude', title: paneId, role, ...extra } as MissionPaneSpec;
}

describe('operatorTabMissionResumeSpec (F-661)', () => {
  it('a retomada lembra a delegação proporcional sem apagar restrições explícitas', () => {
    expect(OPERATOR_TAB_RESUME_NOTE).toContain('nexus_pane_spawn({task, prompt})');
    expect(OPERATOR_TAB_RESUME_NOTE).toContain('readOnly:true');
    expect(OPERATOR_TAB_RESUME_NOTE).toContain('Integre e valide');
    expect(OPERATOR_TAB_RESUME_NOTE).toContain('Tarefa pequena ou conversa');
    expect(OPERATOR_TAB_RESUME_NOTE).toContain('restrições explícitas do operador e do ambiente');
  });

  it('retoma o orquestrador mais recente da missão da aba', () => {
    const chosen = operatorTabMissionResumeSpec(tabMission, [
      spec('pane-operador', 'orchestrator'),
      spec('pane-retomado', 'orchestrator'),
      spec('pane-helper', 'worker'),
    ]);
    expect(chosen?.paneId).toBe('pane-retomado');
  });

  it('missão com squad ou sem pane adotado segue o Maestro do squad', () => {
    const specs = [spec('pane-operador', 'orchestrator')];
    expect(operatorTabMissionResumeSpec({ ...tabMission, squadId: 'nexus-fullstack' }, specs)).toBeNull();
    expect(operatorTabMissionResumeSpec({ squadId: undefined, intentContract: undefined } as never, specs)).toBeNull();
    expect(operatorTabMissionResumeSpec(tabMission, [spec('pane-helper', 'worker')])).toBeNull();
  });

  it('o orquestrador retomado leva CLI, modelo e esforço do pane', () => {
    const agent = operatorTabResumeAgent(
      spec('pane-operador', 'orchestrator', { model: 'claude-opus-5-5', effort: 'high', agentName: 'Orquestrador' }),
    );
    expect(agent).toMatchObject({
      category: 'orchestrator', cli: 'claude', model: 'claude-opus-5-5', effort: 'high', agentName: 'Orquestrador',
    });
  });
});

describe('operatorTabResumeAwaitsAdjustment (F-665)', () => {
  const at = (stamp: string) => ({ description: `x

<!-- nexus:awaiting-adjustment${stamp} -->` });
  it('só o ajuste recém-pedido segura a conversa retomada', () => {
    const now = 1_000_000_000;
    expect(operatorTabResumeAwaitsAdjustment(at(`:${now - 60_000}`), now)).toBe(true);
    expect(operatorTabResumeAwaitsAdjustment(at(`:${now - 3 * 60 * 60_000}`), now)).toBe(false);
    expect(operatorTabResumeAwaitsAdjustment(at(''), now)).toBe(false);
    expect(operatorTabResumeAwaitsAdjustment({ description: 'sem marcador' }, now)).toBe(false);
  });
});

describe('transferência da conversa da aba (F-721)', () => {
  afterEach(() => resetOperatorTabResumeTransfersForTests());

  it('o pane de origem é do Main só enquanto a transferência está em andamento', () => {
    const release = beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    expect(release).toBeTypeOf('function');
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-antigo')).toBe(true);
    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(true);
    // Outro pane ou outra missão não são tocados.
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-novo')).toBe(false);
    expect(isOperatorTabResumeTransferSource('mission-b', 'pane-antigo')).toBe(false);
    expect(operatorTabResumeTransferInFlight('mission-b')).toBe(false);
    release!();
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-antigo')).toBe(false);
    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(false);
  });

  it('uma segunda retomada da mesma missão não começa enquanto a primeira não termina', () => {
    const first = beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    expect(beginOperatorTabResumeTransfer('mission-a', 'pane-antigo')).toBeNull();
    expect(beginOperatorTabResumeTransfer('mission-b', 'pane-outro')).toBeTypeOf('function');
    first!();
    // Liberar duas vezes não apaga a reserva de uma tentativa posterior.
    const second = beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    first!();
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-antigo')).toBe(true);
    second!();
  });
});

describe('worker morto com dispatch ativo na nota de retomada', () => {
  const dispatch = (extra: Partial<Record<string, unknown>> = {}) => ({
    taskId: 'task-1',
    missionId: 'm',
    state: 'running',
    paneId: 'pty-worker-9',
    sessionId: 'session-worker',
    adapterId: 'claude',
    ...extra,
  }) as never;

  const workerPane = (extra: Partial<MissionPaneSpec> = {}) =>
    spec('pty-worker-9', 'worker', { adapterId: 'claude', accountId: 'acct-1', ...extra });

  it('task despachada cujo pane morreu entra na nota com o paneId', () => {
    const orphans = listOrphanedDispatchTasks({
      dispatches: [dispatch()],
      panes: [workerPane()],
      taskTitle: (taskId) => (taskId === 'task-1' ? 'Ajustar login do Codex' : undefined),
      paneAlive: () => false,
      resumablePane: () => true,
    });
    expect(orphans).toEqual([
      {
        taskId: 'task-1',
        title: 'Ajustar login do Codex',
        state: 'running',
        paneId: 'pty-worker-9',
        adapterId: 'claude',
        resumable: true,
      },
    ]);
    const note = buildOrphanedDispatchTaskNote(orphans);
    expect(note).toContain('Ajustar login do Codex');
    expect(note).toContain('task-1');
    expect(note).toContain('pty-worker-9');
    // Sessão gravada: o caminho preferencial é retomar o pane antigo, não abrir outro.
    expect(note).toContain("nexus_pane_spawn({resume:'pty-worker-9'");
    expect(note).not.toContain('re-despache');
  });

  it('pane vivo, dispatch encerrado ou pane do operador não entram na nota', () => {
    expect(listOrphanedDispatchTasks({
      dispatches: [dispatch()],
      panes: [workerPane()],
      taskTitle: () => 'x',
      paneAlive: () => true,
      resumablePane: () => true,
    })).toEqual([]);
    for (const state of ['completed', 'failed', 'superseded', 'handoff_ready', 'blocked']) {
      expect(listOrphanedDispatchTasks({
        dispatches: [dispatch({ state })],
        panes: [workerPane()],
        taskTitle: () => 'x',
        paneAlive: () => false,
        resumablePane: () => true,
      })).toEqual([]);
    }
    // F-231: pane aberto pelo operador é mão dele, nunca entra na lista.
    expect(listOrphanedDispatchTasks({
      dispatches: [dispatch()],
      panes: [workerPane({ operatorOpened: true })],
      taskTitle: () => 'x',
      paneAlive: () => false,
      resumablePane: () => true,
    })).toEqual([]);
    expect(buildOrphanedDispatchTaskNote([])).toBe('');
  });

  it('sem sessão gravada a nota manda re-despachar em vez de retomar', () => {
    const note = buildOrphanedDispatchTaskNote(listOrphanedDispatchTasks({
      dispatches: [dispatch()],
      panes: [workerPane()],
      taskTitle: () => 'Ajustar login do Codex',
      paneAlive: () => false,
      resumablePane: () => false,
    }));
    expect(note).toContain('pty-worker-9');
    expect(note).not.toContain('resume:');
    expect(note).toContain('re-despache');
  });

  it('dispatch ativo sem paneId nenhum não vira órfã inventada', () => {
    expect(listOrphanedDispatchTasks({
      dispatches: [dispatch({ paneId: undefined })],
      panes: [],
      taskTitle: () => 'x',
      paneAlive: () => false,
      resumablePane: () => true,
    })).toEqual([]);
  });
});

describe('planOperatorTabResume (conversa esquecida não trava a retomada)', () => {
  it('conversa gravada na mesma conta: retoma exato', () => {
    expect(planOperatorTabResume({ sameAccount: true, conversationRecorded: true }))
      .toEqual({ resumeFromPane: true, replaceRow: false, conversationLost: false });
  });

  it('vínculo esquecido (CLI disse "No conversation found"): nasce nova em vez de recusar para sempre', () => {
    const plan = planOperatorTabResume({ sameAccount: true, conversationRecorded: false });
    expect(plan).toEqual({ resumeFromPane: false, replaceRow: true, conversationLost: true });
    expect(OPERATOR_TAB_RESUME_LOST_NOTE).toContain('nexus_handoff_list');
  });

  it('troca de conta segue o caminho já existente (conversa nova, linha substituída)', () => {
    expect(planOperatorTabResume({ sameAccount: false, conversationRecorded: true }))
      .toEqual({ resumeFromPane: false, replaceRow: true, conversationLost: false });
  });
});

describe('transferência da conversa da aba — TTL (A9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    traceMock.mockClear();
  });
  afterEach(() => {
    resetOperatorTabResumeTransfersForTests();
    vi.useRealTimers();
  });

  it('passou de 60 s com a reserva viva: trace de alerta, sem expirar', () => {
    beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    vi.advanceTimersByTime(60_000);
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'operator-tab-resume-transfer-stale', missionId: 'mission-a' }),
    );
    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(true);
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-antigo')).toBe(true);
  });

  it('spawn que não nasce no TTL: a reserva expira e uma nova retomada é aceita', () => {
    const stuck = beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    expect(stuck).toBeTypeOf('function');
    expect(beginOperatorTabResumeTransfer('mission-a', 'pane-antigo')).toBeNull();

    vi.advanceTimersByTime(OPERATOR_TAB_RESUME_TRANSFER_TTL_MS + 1);

    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(false);
    expect(isOperatorTabResumeTransferSource('mission-a', 'pane-antigo')).toBe(false);
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'operator-tab-resume-transfer-expired', missionId: 'mission-a' }),
    );
    // Nova retomada da mesma missão volta a ser aceita.
    expect(beginOperatorTabResumeTransfer('mission-a', 'pane-antigo')).toBeTypeOf('function');
  });

  it('mesmo sem o timer disparar, leitura depois do TTL não enxerga a reserva', () => {
    beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    // Relógio avança sem timers (proteção contra ambiente sem o watchdog).
    const base = Date.now();
    vi.setSystemTime(base + OPERATOR_TAB_RESUME_TRANSFER_TTL_MS + 1);
    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(false);
    expect(beginOperatorTabResumeTransfer('mission-a', 'pane-antigo')).toBeTypeOf('function');
  });

  it('liberação antes do TTL não traceia nem expira nada', () => {
    const release = beginOperatorTabResumeTransfer('mission-a', 'pane-antigo');
    release!();
    vi.advanceTimersByTime(OPERATOR_TAB_RESUME_TRANSFER_TTL_MS * 2);
    expect(traceMock).not.toHaveBeenCalled();
    expect(operatorTabResumeTransferInFlight('mission-a')).toBe(false);
  });
});
