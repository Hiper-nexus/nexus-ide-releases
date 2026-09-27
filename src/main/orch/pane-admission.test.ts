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

  it('memória livre abaixo do mínimo AVISA por padrão e recusa com a trava dura', () => {
    const tight = { freeMB: DEFAULT_PANE_ADMISSION_LIMITS.minFreeMB - 1, swapUsedMB: 0 };
    const verdict = evaluatePaneAdmission(input({ memory: tight }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warning ?? '').toMatch(/livre/i);
    // A válvula continua existindo para quem quiser o comportamento antigo.
    const hard = readPaneAdmissionLimits({ NEXUS_PANE_CAP_HARD: '1' }, 24 * 1024);
    const blocked = evaluatePaneAdmission(input({ limits: hard, memory: tight }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('memory');
    expect(blocked.message).toMatch(/livre/i);
  });

  it('swap acima do teto AVISA por padrão e recusa com a trava dura (gate armado por máquina)', () => {
    // O gate de swap nasce DESARMADO (maxSwapUsedMB = 0): swap em uso não é
    // sinal de pressão. Quem quiser o gate numa máquina o arma por env.
    const armed = readPaneAdmissionLimits({ NEXUS_PANE_MAX_SWAP_MB: '1024' }, 24 * 1024);
    const highSwap = { freeMB: 8_000, swapUsedMB: 1_025 };
    const verdict = evaluatePaneAdmission(input({ limits: armed, memory: highSwap }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warning ?? '').toMatch(/swap/i);
    expect(verdict.warning ?? '').toContain('NEXUS_PANE_MAX_SWAP_MB');
    const hard = readPaneAdmissionLimits(
      { NEXUS_PANE_MAX_SWAP_MB: '1024', NEXUS_PANE_GUARD: 'hard' },
      24 * 1024,
    );
    const blocked = evaluatePaneAdmission(input({ limits: hard, memory: highSwap }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('memory');
    expect(blocked.message).toMatch(/swap/i);
  });

  it('sem o gate armado, swap alto não gera nem aviso de paginação', () => {
    const verdict = evaluatePaneAdmission(
      input({ memory: { freeMB: 8_000, swapUsedMB: 23_023 } }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warning).toBeUndefined();
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
      // 24 GB explícitos: o default da máquina real muda o mínimo livre (15 %
      // da RAM) e o teste passaria só numa máquina daquele tamanho.
      const limits = readPaneAdmissionLimits(
        {
          NEXUS_PANE_CAP: '20',
          NEXUS_PANE_MIN_FREE_MB: 'abc',
          NEXUS_PANE_MAX_SWAP_MB: '4096',
        },
        24 * 1024,
      );
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
    // A amostra em cache chega ao gate sem `sysctl`; por padrão ela AVISA
    // (0.76.47) e não recusa.
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.warning ?? '').toMatch(/livre|swap/i);
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

describe('pane-admission: swap do Windows é commit, não swap (F-574)', () => {
  it('não lê ullTotalPageFile/ullAvailPageFile como swap no win32', async () => {
    const { parseElectronSwapUsedMB } = await import('./pane-admission');
    // Amostra real desta máquina (16/09, 64 GB): limite de commit 75.670.796 KB
    // − 52.091.424 KB livres = 23.023 MB de "swap", com 143 MB de pagefile real.
    expect(
      parseElectronSwapUsedMB({ swapTotal: 75_670_796, swapFree: 52_091_424 }, 'win32'),
    ).toBeNull();
    // Linux mantém a leitura real do sysinfo.
    expect(parseElectronSwapUsedMB({ swapTotal: 2_097_152, swapFree: 1_048_576 }, 'linux')).toBe(1024);
    expect(parseElectronSwapUsedMB({}, 'linux')).toBeNull();
  });

  it('no Windows o gate decide só pela memória livre, não pelo commit', async () => {
    const verdict = evaluatePaneAdmission(input({ memory: { freeMB: 44_547, swapUsedMB: null } }));
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.warning === undefined).toBe(true);
    // O valor antigo (commit lido como swap) não avisa nem trava: é o bug que
    // o gate não pode voltar a ter nesta plataforma (0.76.47).
    const warned = evaluatePaneAdmission(input({ memory: { freeMB: 44_547, swapUsedMB: 23_023 } }));
    expect(warned.ok).toBe(true);
    expect(warned.ok && warned.warning === undefined).toBe(true);
  });

  it('um pico de swap parado não é pressão: o reaper não estaciona pane à toa', async () => {
    const { isUnderMemoryPressure, limitsForMachine } = await import('./pane-admission');
    // Leitura real da máquina do operador: 8.151 MB de swap com o kernel em
    // NORMAL e 62 % de RAM livre. Antes, isto ligava o reaper de emergência
    // a cada 60 s para sempre.
    const limits = limitsForMachine(24 * 1024);
    expect(isUnderMemoryPressure({ freeMB: 0.62 * 24 * 1024, swapUsedMB: 8_151 }, limits)).toBe(
      false,
    );
    // Pressão de verdade (abaixo do piso) continua ligando.
    expect(isUnderMemoryPressure({ freeMB: limits.minFreeMB - 1, swapUsedMB: 8_151 }, limits)).toBe(
      true,
    );
  });
});

describe('pane-admission: limites proporcionais à RAM da máquina (0.76.44)', () => {
  it('num Mac de 24 GB o mínimo disponível é 15 % (3,6 GB), o swap nasce sem gate e o teto 12', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(24 * 1024);
    expect(limits.minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
    expect(limits.maxSwapUsedMB).toBe(0);
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
    // Swap não é sinal de pressão sem o gate armado pela máquina (0.76.47).
    expect(isUnderMemoryPressure({ freeMB: 10_000, swapUsedMB: 3_000 }, limits)).toBe(false);
    expect(isUnderMemoryPressure(null, limits)).toBe(false);
  });

  it('spawn delegado e manual avisam no teto; só opt-in explícito pode bloquear', async () => {
    const { admitAgentSpawnSync, readPaneAdmissionLimits, registerPaneAdmissionAdvisor, primeSystemMemoryCacheForTest } =
      await import('./pane-admission');
    primeSystemMemoryCacheForTest({ freeMB: 64_000, swapUsedMB: 0 });
    registerPaneAdmissionAdvisor(null);
    // O teto real desta máquina (env vazio), não o default: o gate lê a RAM.
    const atCap = readPaneAdmissionLimits({}).maxAgentPanes;
    const byAgent = admitAgentSpawnSync(atCap, Date.now(), {}, { agentRequested: true });
    const byHand = admitAgentSpawnSync(atCap, Date.now(), {});
    expect(byAgent).toEqual(byHand);
    expect(byHand.ok).toBe(true);
    expect(byHand.ok && byHand.warning).toBeTruthy();
    const off = admitAgentSpawnSync(atCap, Date.now(), { NEXUS_PANE_GUARD: 'off' }, { agentRequested: true });
    expect(off.ok).toBe(true);
    for (const env of [{ NEXUS_PANE_CAP_HARD: '1' }, { NEXUS_PANE_GUARD: 'hard' }]) {
      expect(admitAgentSpawnSync(atCap, Date.now(), env, { agentRequested: true }).ok).toBe(false);
      expect(admitAgentSpawnSync(atCap, Date.now(), env).ok).toBe(false);
    }
    primeSystemMemoryCacheForTest({ freeMB: 1, swapUsedMB: 0 });
    const lowMemory = admitAgentSpawnSync(0, Date.now(), {}, { agentRequested: true });
    expect(lowMemory).toMatchObject({ ok: true, warning: expect.stringContaining('Memória livre baixa') });
  });
});
