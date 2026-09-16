import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PANE_ADMISSION_LIMITS,
  evaluatePaneAdmission,
  readPaneAdmissionLimits,
  type PaneAdmissionInput,
} from './pane-admission';

function input(overrides: Partial<PaneAdmissionInput> = {}): PaneAdmissionInput {
  return {
    liveAgentPanes: 3,
    limits: DEFAULT_PANE_ADMISSION_LIMITS,
    memory: { freeMB: 8_000, swapUsedMB: 0 },
    idleCandidates: [],
    ...overrides,
  };
}

describe('pane-admission (F-572): teto de panes + gate por memória', () => {
  it('admite quando há folga de panes e de memória', () => {
    const verdict = evaluatePaneAdmission(input());
    expect(verdict.ok).toBe(true);
  });

  it('no teto de panes AVISA (não trava) e nomeia os panes ociosos a fechar', () => {
    const verdict = evaluatePaneAdmission(
      input({
        liveAgentPanes: DEFAULT_PANE_ADMISSION_LIMITS.maxAgentPanes,
        idleCandidates: [
          { paneId: 'pane-a', paneNumber: 7, title: 'Revisor', idleForMs: 90_000 },
          { paneId: 'pane-b', paneNumber: 3, title: 'Helper', idleForMs: 30_000 },
        ],
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const warning = verdict.warning ?? '';
    expect(warning).toContain(`${DEFAULT_PANE_ADMISSION_LIMITS.maxAgentPanes}`);
    // O mais ocioso primeiro, pelo número que o operador fala.
    expect(warning.indexOf('pane 7')).toBeLessThan(warning.indexOf('pane 3'));
    expect(warning).toContain('nexus_pane_close');
  });

  it('com NEXUS_PANE_CAP_HARD o teto volta a bloquear', () => {
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_CAP_HARD: '1' }, 24 * 1024);
    const verdict = evaluatePaneAdmission(input({ limits, liveAgentPanes: limits.maxAgentPanes }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('cap');
  });

  it('recusa por memória livre abaixo do mínimo', () => {
    const verdict = evaluatePaneAdmission(
      input({ memory: { freeMB: DEFAULT_PANE_ADMISSION_LIMITS.minFreeMB - 1, swapUsedMB: 0 } }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('memory');
    expect(verdict.message).toMatch(/livre/i);
  });

  it('recusa por swap acima do teto', () => {
    const verdict = evaluatePaneAdmission(
      input({ memory: { freeMB: 8_000, swapUsedMB: DEFAULT_PANE_ADMISSION_LIMITS.maxSwapUsedMB + 1 } }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('memory');
    expect(verdict.message).toMatch(/swap/i);
  });

  it('memória desconhecida não bloqueia; acima do teto só avisa', () => {
    expect(evaluatePaneAdmission(input({ memory: null })).ok).toBe(true);
    const capped = evaluatePaneAdmission(
      input({ memory: null, liveAgentPanes: DEFAULT_PANE_ADMISSION_LIMITS.maxAgentPanes }),
    );
    expect(capped.ok && Boolean(capped.warning)).toBe(true);
  });

  it('avisa a partir de 80% do teto sem recusar', () => {
    const limits = { ...DEFAULT_PANE_ADMISSION_LIMITS, maxAgentPanes: 10 };
    // 7 vivos + este = 8/10 → avisa; 6 vivos + este = 7/10 → silêncio.
    const verdict = evaluatePaneAdmission(input({ limits, liveAgentPanes: 7 }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warning).toMatch(/8\/10/);
    const quiet = evaluatePaneAdmission(input({ limits, liveAgentPanes: 6 }));
    expect(quiet.ok && quiet.warning === undefined).toBe(true);
  });

  it('teto desligado (guard off) admite sempre, mas ainda relata a memória', () => {
    const verdict = evaluatePaneAdmission(
      input({
        limits: { ...DEFAULT_PANE_ADMISSION_LIMITS, enabled: false },
        liveAgentPanes: 99,
        memory: { freeMB: 10, swapUsedMB: 9_000 },
      }),
    );
    expect(verdict.ok).toBe(true);
  });

  describe('readPaneAdmissionLimits: overrides por env', () => {
    it('usa os defaults da máquina sem env (referência: Mac de 24 GB)', () => {
      expect(readPaneAdmissionLimits({}, 24 * 1024)).toEqual(DEFAULT_PANE_ADMISSION_LIMITS);
    });

    it('aceita inteiros válidos e ignora lixo', () => {
      const limits = readPaneAdmissionLimits({
        NEXUS_PANE_CAP: '20',
        NEXUS_PANE_MIN_FREE_MB: 'abc',
        NEXUS_PANE_MAX_SWAP_MB: '4096',
      });
      expect(limits.maxAgentPanes).toBe(20);
      expect(limits.minFreeMB).toBe(DEFAULT_PANE_ADMISSION_LIMITS.minFreeMB);
      expect(limits.maxSwapUsedMB).toBe(4096);
    });

    it('teto abaixo de 1 volta ao default (nunca zero)', () => {
      expect(readPaneAdmissionLimits({ NEXUS_PANE_CAP: '0' }, 24 * 1024).maxAgentPanes).toBe(
        DEFAULT_PANE_ADMISSION_LIMITS.maxAgentPanes,
      );
    });

    it('NEXUS_PANE_GUARD=off desliga o guard', () => {
      expect(readPaneAdmissionLimits({ NEXUS_PANE_GUARD: 'off' }).enabled).toBe(false);
    });
  });
});

describe('pane-admission: cache síncrono da memória para o gate de spawn', () => {
  it('o gate lê a amostra em cache sem esperar sysctl', async () => {
    const { getCachedSystemMemory, primeSystemMemoryCacheForTest } = await import('./pane-admission');
    primeSystemMemoryCacheForTest({ freeMB: 12, swapUsedMB: 9_000 }, Date.now());
    const verdict = evaluatePaneAdmission(
      input({ memory: getCachedSystemMemory(Date.now()) }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('memory');
  });

  it('cache vencido devolve a última amostra e não inventa pressão quando nunca houve', async () => {
    const { getCachedSystemMemory, primeSystemMemoryCacheForTest } = await import('./pane-admission');
    primeSystemMemoryCacheForTest(null, 0);
    // Sem getSystemMemoryInfo (fora do Electron) o refresh grava null: gate
    // fail-open na memória, o teto de panes continua valendo.
    expect(getCachedSystemMemory(Date.now())).toBeNull();
    expect(evaluatePaneAdmission(input({ memory: getCachedSystemMemory() })).ok).toBe(true);
  });

  it('parseDarwinSwapUsage lê MB e GB', async () => {
    const { parseDarwinSwapUsage } = await import('./pane-admission');
    expect(parseDarwinSwapUsage('total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)')).toBe(1234.5);
    expect(parseDarwinSwapUsage('total = 4.00G  used = 1.50G  free = 2.50G')).toBe(1536);
    expect(parseDarwinSwapUsage('garbage')).toBeNull();
  });
});

describe('pane-admission: sinal do kernel no macOS + gate síncrono com conselheiro', () => {
  it('parseDarwinSysctl converte memorystatus_level × memsize em MB disponíveis', async () => {
    const { parseDarwinSysctl } = await import('./pane-admission');
    const reading = parseDarwinSysctl(
      '51\ntotal = 1024.00M  used = 186.88M  free = 837.12M  (encrypted)\n25769803776\n',
    );
    expect(reading.swapUsedMB).toBeCloseTo(186.88, 2);
    // 51% de 24576 MB
    expect(reading.availableMB).toBeCloseTo(0.51 * 24576, 0);
    expect(parseDarwinSysctl('garbage')).toEqual({ availableMB: null, swapUsedMB: null });
  });

  it('um Mac saudável (830 MB "free", nível 51%, swap 187 MB) NÃO é recusado', async () => {
    const { parseDarwinSysctl } = await import('./pane-admission');
    const reading = parseDarwinSysctl(
      '51\ntotal = 1024.00M  used = 186.88M  free = 837.12M  (encrypted)\n25769803776\n',
    );
    const verdict = evaluatePaneAdmission(
      input({ memory: { freeMB: reading.availableMB, swapUsedMB: reading.swapUsedMB } }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('admitAgentSpawnSync usa o conselheiro para nomear os ociosos e nunca lança', async () => {
    const { admitAgentSpawnSync, registerPaneAdmissionAdvisor, primeSystemMemoryCacheForTest } =
      await import('./pane-admission');
    primeSystemMemoryCacheForTest({ freeMB: 8_000, swapUsedMB: 0 });
    registerPaneAdmissionAdvisor({
      idleCandidates: () => [{ paneId: 'pane-x', paneNumber: 4, title: 'Helper', idleForMs: 120_000 }],
    });
    const verdict = admitAgentSpawnSync(DEFAULT_PANE_ADMISSION_LIMITS.maxAgentPanes, Date.now(), { NEXUS_PANE_CAP_HARD: '1' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain('pane 4');

    registerPaneAdmissionAdvisor({
      idleCandidates: () => { throw new Error('registro quebrado'); },
    });
    const still = admitAgentSpawnSync(0, Date.now(), {});
    expect(still.ok).toBe(true);
    registerPaneAdmissionAdvisor(null);
  });
});

describe('pane-admission: limites proporcionais à RAM da máquina (0.76.44)', () => {
  it('num Mac de 24 GB o mínimo disponível é 15 % (3,6 GB), o swap 1 GB e o teto 12', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(24 * 1024);
    expect(limits.minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
    expect(limits.maxSwapUsedMB).toBe(1024);
    expect(limits.maxAgentPanes).toBe(12);
  });

  it('num Mac de 16 GB o teto cai para 6 e o mínimo disponível nunca fica abaixo de 1 GB', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(16 * 1024);
    expect(limits.maxAgentPanes).toBe(6);
    expect(limits.minFreeMB).toBeGreaterThanOrEqual(1024);
  });

  it('numa máquina de 64 GB o teto satura em 12 (o guardian, não a RAM, governa)', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    expect(limitsForMachine(64 * 1024).maxAgentPanes).toBe(12);
  });

  it('env continua sobrepondo os defaults proporcionais', async () => {
    const { readPaneAdmissionLimits } = await import('./pane-admission');
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_CAP: '3' }, 24 * 1024);
    expect(limits.maxAgentPanes).toBe(3);
    expect(limits.minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
  });

  it('isUnderMemoryPressure usa os mesmos limiares do gate', async () => {
    const { isUnderMemoryPressure, limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(24 * 1024);
    expect(isUnderMemoryPressure({ freeMB: 10_000, swapUsedMB: 100 }, limits)).toBe(false);
    expect(isUnderMemoryPressure({ freeMB: 2_000, swapUsedMB: 100 }, limits)).toBe(true);
    expect(isUnderMemoryPressure({ freeMB: 10_000, swapUsedMB: 3_000 }, limits)).toBe(true);
    expect(isUnderMemoryPressure(null, limits)).toBe(false);
  });
});
