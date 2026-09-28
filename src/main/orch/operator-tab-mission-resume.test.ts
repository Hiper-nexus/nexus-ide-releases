import { describe, expect, it } from 'vitest';
import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import {
  operatorTabMissionResumeSpec,
  operatorTabResumeAgent,
} from './operator-tab-mission-resume';

const tabMission = {
  squadId: undefined,
  intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
} as unknown as Pick<Mission, 'squadId' | 'intentContract'>;

function spec(paneId: string, role: 'orchestrator' | 'worker', extra: Partial<MissionPaneSpec> = {}): MissionPaneSpec {
  return { id: `mp-${paneId}`, missionId: 'm', paneId, adapterId: 'claude', title: paneId, role, ...extra } as MissionPaneSpec;
}

describe('operatorTabMissionResumeSpec (F-661)', () => {
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
