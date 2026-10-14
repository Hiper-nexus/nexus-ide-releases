import { afterEach, describe, expect, it } from 'vitest';
import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import {
  OPERATOR_TAB_RESUME_LOST_NOTE,
  OPERATOR_TAB_RESUME_NOTE,
  planOperatorTabResume,
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
