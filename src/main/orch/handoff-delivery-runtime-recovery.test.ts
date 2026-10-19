import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestMissionPaneRecovery: vi.fn(),
  redeliverPendingHandoffs: vi.fn(),
  rebindOrchestratorSession: vi.fn(),
}));

vi.mock('./pane-registry', () => ({
  getPaneRuntimeAuthorityBySession: () => null,
  requestMissionPaneRecovery: mocks.requestMissionPaneRecovery,
}));
vi.mock('./idle-delivery', () => ({
  redeliverPendingHandoffs: mocks.redeliverPendingHandoffs,
}));
vi.mock('./project-scoped-broadcast', () => ({
  sameProjectScope: () => true,
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => ({ id: 'm1', status: 'running', orchestratorSessionId: 'pty-old' }),
      rebindOrchestratorSession: mocks.rebindOrchestratorSession,
    },
    handoffs: {
      get: () => ({ id: 'h1', missionId: 'm1', delivered: false, deliveryState: 'queued' }),
    },
    missionPanes: {
      list: () => [{ role: 'orchestrator', paneId: 'pane-1', authoritySeal: 'seal' }],
    },
  }),
}));

import { recoverHandoffDeliveryRuntime } from './handoff-delivery-runtime-recovery';

const scope = { projectId: 'p', checkoutId: 'c', rootRealPath: '/repo' } as never;

describe('recuperação do Maestro que não aceita a entrega (F-1581)', () => {
  beforeEach(() => {
    mocks.requestMissionPaneRecovery.mockReset().mockResolvedValue({
      requestId: 'r1', ok: true, paneId: 'pane-1', sessionId: 'pty-new',
    });
    mocks.rebindOrchestratorSession.mockReset().mockReturnValue({ orchestratorSessionId: 'pty-new' });
    mocks.redeliverPendingHandoffs.mockReset();
  });

  it('pede a sessão nova dizendo o motivo, para o terminal não falar em "contexto degradado"', async () => {
    await expect(recoverHandoffDeliveryRuntime({
      scope, missionId: 'm1', sessionId: 'pty-old', paneId: 'pane-1', handoffId: 'h1',
    } as never)).resolves.toBe(true);
    expect(mocks.requestMissionPaneRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'handoff-delivery', expectedSessionId: 'pty-old' }),
    );
    expect(mocks.redeliverPendingHandoffs).toHaveBeenCalledWith(scope, 'm1');
  });
});
