import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { licensedAccessMock, resetLicensedAccessMock } from '../__tests__/licensed-access';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('../pty/pty-manager', () => ({ countLiveAgentSessions: vi.fn(() => 1) }));

import {
  AGENT_PANE_FOOTPRINT_MB,
  admitAgentSpawnSync,
  primeSystemMemoryCacheForTest,
  registerAgentMemoryCensus,
  registerHeavyCommandMemoryReservation,
} from './pane-admission';
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

describe('currentParallelHelperBudget: a memória é a do gate de spawn, não a amostra crua', () => {
  const now = Date.now();

  beforeEach(() => {
    resetLicensedAccessMock();
    licensedAccessMock.maxAgents.mockReturnValue(null);
    vi.stubEnv('NEXUS_PANE_GUARD', '');
    vi.stubEnv('NEXUS_PANE_CAP', '12');
    vi.stubEnv('NEXUS_PANE_MIN_FREE_MB', '1024');
  });

  afterEach(() => {
    registerHeavyCommandMemoryReservation(() => 0);
    primeSystemMemoryCacheForTest(null);
    vi.unstubAllEnvs();
  });

  it('build pesado e pane iniciando: o leque não anuncia a vaga que o gate recusaria', () => {
    let heavyMB = 2_048;
    registerHeavyCommandMemoryReservation(() => heavyMB);
    // O Maestro vivo ainda iniciando: a amostra não o mediu.
    const undo = registerAgentMemoryCensus(() => ({ live: 1, pending: 1 }), 'test-budget');
    try {
      primeSystemMemoryCacheForTest({ freeMB: 1_024 + 6 * AGENT_PANE_FOOTPRINT_MB, swapUsedMB: 0 }, now);
      // Crua: 6 vagas. Com 1280 do pane iniciando e 2048 do build: 5376 MB → 3.
      expect(currentParallelHelperBudget(now)).toMatchObject({ slots: 3, limitedBy: 'memory', freeMB: 5_376 });
      expect(admitAgentSpawnSync(1, now, process.env, { automaticWorker: true }).ok).toBe(true);

      // Mais dois builds: 1280 MB livres, nenhuma vaga — e o gate concorda.
      heavyMB = 3 * 2_048;
      expect(currentParallelHelperBudget(now)).toMatchObject({ slots: 0, limitedBy: 'memory', freeMB: 1_280 });
      expect(admitAgentSpawnSync(1, now, process.env, { automaticWorker: true })).toMatchObject({
        ok: false,
        reason: 'memory',
      });
    } finally {
      undo();
    }
  });
});
