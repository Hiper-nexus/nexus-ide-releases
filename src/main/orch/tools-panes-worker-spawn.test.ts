import { describe, expect, it } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  assertCallerMaySpawnPane,
  coerceSpawnReadOnly,
  paneSpawnTool,
} from './tools-panes';

function context(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'token',
    label: 'worker',
    role: 'worker',
    sessionId: 'session-worker',
    missionId: 'mission-1',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

describe('assertCallerMaySpawnPane', () => {
  it('recusa worker com erro visível — sem pane-neto', () => {
    expect(() => assertCallerMaySpawnPane('worker')).toThrow(
      /workers cannot create panes/i,
    );
  });

  it('deixa orquestrador e usuário spawnar (handoff do maestro intacto)', () => {
    expect(() => assertCallerMaySpawnPane('orchestrator')).not.toThrow();
    expect(() => assertCallerMaySpawnPane('user')).not.toThrow();
  });
});

describe('nexus_pane_spawn recusa worker antes de qualquer spawn', () => {
  it('worker → spawn pane falha visível (ad-hoc e agentName)', async () => {
    const worker = context();
    await expect(
      paneSpawnTool.handler({ adapterId: 'codex' }, worker),
    ).rejects.toThrow(/workers cannot create panes/i);
    await expect(
      paneSpawnTool.handler(
        { agentName: 'Executor', adapterId: 'codex' },
        worker,
      ),
    ).rejects.toThrow(/workers cannot create panes/i);
  });

  it('orquestrador não é cortado por este gate', async () => {
    try {
      await paneSpawnTool.handler(
        { adapterId: 'codex' },
        context({ role: 'orchestrator', label: 'orch' }),
      );
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toMatch(
        /workers cannot create panes/i,
      );
    }
  });
});

describe('coerceSpawnReadOnly', () => {
  it('preserva readOnly=false quando o chamador não é read-only', () => {
    expect(coerceSpawnReadOnly({ readOnly: false }, false)).toEqual({
      readOnly: false,
    });
    expect(coerceSpawnReadOnly({ readOnly: false }, undefined)).toEqual({
      readOnly: false,
    });
  });

  it('força readOnly=true quando o chamador é read-only', () => {
    expect(coerceSpawnReadOnly({}, true)).toEqual({ readOnly: true });
    expect(coerceSpawnReadOnly({ readOnly: false }, true)).toEqual({
      readOnly: true,
    });
    expect(coerceSpawnReadOnly({ readOnly: true }, true)).toEqual({
      readOnly: true,
    });
  });
});
