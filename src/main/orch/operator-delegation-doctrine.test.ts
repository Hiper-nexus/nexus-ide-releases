import { describe, expect, it } from 'vitest';
import {
  OPERATOR_DELEGATION_DOCTRINE,
  operatorDelegationInstructions,
} from './operator-delegation-doctrine';

describe('doutrina de delegação da mão do operador', () => {
  it('cabe em 1,5 KB e cobre os pontos da spec', () => {
    expect(Buffer.byteLength(OPERATOR_DELEGATION_DOCTRINE, 'utf8')).toBeLessThanOrEqual(1536);
    for (const needle of ['nexus_pane_spawn', 'readOnly: true', 'um helper por vez', 'encerre o turno', 'nexus_handoff_submit', 'não insista', 'ponytail', 'DESIGN.md', 'nexus_design_system_local_list', 'cara de IA']) {
      expect(OPERATOR_DELEGATION_DOCTRINE).toContain(needle);
    }
    // Não existe spawn em lote (`panes: [...]`) — a doutrina não pode prometer.
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('panes:');
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('adapterId:');
  });

  it('só a mão do operador sem missão recebe', () => {
    expect(operatorDelegationInstructions({ role: 'user' })).toBe(OPERATOR_DELEGATION_DOCTRINE);
    expect(operatorDelegationInstructions({ role: 'user', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'orchestrator', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'worker', missionId: 'm' })).toBeUndefined();
  });
});
