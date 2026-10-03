import { describe, expect, it } from 'vitest';
import {
  OPERATOR_DELEGATION_DOCTRINE,
  operatorDelegationInstructions,
} from './operator-delegation-doctrine';

describe('doutrina de delegação da mão do operador', () => {
  it('cabe em 1,5 KB e cobre os pontos da spec', () => {
    expect(Buffer.byteLength(OPERATOR_DELEGATION_DOCTRINE, 'utf8')).toBeLessThanOrEqual(1536);
    for (const needle of ['nexus_pane_spawn', 'readOnly: true', 'isolatedWriter: true', 'worktree/branch própria', 'encerre o turno', 'nexus_handoff_submit', 'não insista', 'ponytail', 'DESIGN.md', 'nexus_design_system_local_list', 'cara de IA', 'nexus_browser_*', 'adapterId + model', 'nexus_route_task', 'nexus_tool_pick', 'nexus_memory_recall']) {
      expect(OPERATOR_DELEGATION_DOCTRINE).toContain(needle);
    }
    // F-802: o pin de CLI só vale quando o operador a nomeou (F-682).
    expect(OPERATOR_DELEGATION_DOCTRINE).toContain('se o operador nomeou a CLI');
    // Não existe spawn em lote (`panes: [...]`) — a doutrina não pode prometer.
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('panes:');
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('adapterId:');
    // 0.76.110: writers não são mais serializados na mão do operador.
    expect(OPERATOR_DELEGATION_DOCTRINE).not.toContain('um helper por vez');
  });

  it('Codex (cola as instructions em cada tool) e Kimi (não as lê) não recebem pelo MCP: vai pelo hook', () => {
    expect(operatorDelegationInstructions({ role: 'user', providerId: 'codex' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'user', providerId: 'kimi' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'user', providerId: 'grok' })).toBe(OPERATOR_DELEGATION_DOCTRINE);
    expect(operatorDelegationInstructions({ role: 'user', providerId: 'claude' })).toBe(OPERATOR_DELEGATION_DOCTRINE);
  });

  it('só a mão do operador sem missão recebe', () => {
    expect(operatorDelegationInstructions({ role: 'user' })).toBe(OPERATOR_DELEGATION_DOCTRINE);
    expect(operatorDelegationInstructions({ role: 'user', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'orchestrator', missionId: 'm' })).toBeUndefined();
    expect(operatorDelegationInstructions({ role: 'worker', missionId: 'm' })).toBeUndefined();
  });
});
