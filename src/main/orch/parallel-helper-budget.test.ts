import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { licensedAccessMock, resetLicensedAccessMock } from '../__tests__/licensed-access';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('../pty/pty-manager', () => ({ countLiveAgentSessions: vi.fn(() => 1) }));

import { primeSystemMemoryCacheForTest } from './pane-admission';
import { currentParallelHelperBudget } from './parallel-helper-budget';

describe('currentParallelHelperBudget: teto de agentes da licença', () => {
  const now = Date.now();

  beforeEach(() => {
    resetLicensedAccessMock();
    // Limites fixos: o padrão escala com a RAM do host de teste.
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    vi.stubEnv('NEXUS_PANE_CAP', '12');
    vi.stubEnv('NEXUS_PANE_MIN_FREE_MB', '1024');
    primeSystemMemoryCacheForTest({ freeMB: 40_000, swapUsedMB: 0 }, now);
  });

  afterEach(() => {
    primeSystemMemoryCacheForTest(null);
    vi.unstubAllEnvs();
  });

  it('Trial com 6 agentes: o Maestro vivo e no máximo 4 helpers, sobra 1 vaga para o revisor', () => {
    licensedAccessMock.maxAgents.mockReturnValue(6);
    expect(currentParallelHelperBudget(now)).toMatchObject({ slots: 4, limitedBy: 'license' });
  });

  it('Pro/Team (ilimitado): o orçamento é só o da máquina', () => {
    licensedAccessMock.maxAgents.mockReturnValue(null);
    expect(currentParallelHelperBudget(now)).toMatchObject({ slots: 11, limitedBy: 'cap' });
  });

  it('licença ilegível: sem orçamento (fail-open), nunca lança', () => {
    licensedAccessMock.maxAgents.mockImplementation(() => {
      throw new Error('licença indisponível');
    });
    expect(currentParallelHelperBudget(now)).toBeNull();
  });
});
