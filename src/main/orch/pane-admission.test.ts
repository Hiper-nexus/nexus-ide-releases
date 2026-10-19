import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PANE_ADMISSION_LIMITS,
  AGENT_PANE_FOOTPRINT_MB,
  limitsForMachine,
  evaluatePaneAdmission,
  readPaneAdmissionLimits,
  registerAgentMemoryCensus,
  registerHeavyCommandMemoryReservation,
  registerPaneAdmissionAdvisor,
  admitAgentSpawnSync,
  parallelHelperBudget,
  getCachedSystemMemory,
  getMemoryAfterAgentReservations,
  getMemoryForAgentSpawn,
  primeSystemMemoryCacheForTest,
  hasPendingPaneSpawns,
  trackPaneSpawnEntry,
  parseMainPressureRefusal,
  mainPressureNow,
  type PaneAdmissionInput,
  type PaneAdmissionLimits,
} from './pane-admission';

it('counts a pty:spawn entry as pending until its result settles, whatever the outcome (C6)', async () => {
  expect(trackPaneSpawnEntry(() => 'sync')).toBe('sync');
  expect(hasPendingPaneSpawns()).toBe(false);
  expect(() => trackPaneSpawnEntry(() => { throw new Error('refused'); })).toThrow('refused');
  expect(hasPendingPaneSpawns()).toBe(false);

  let fail!: (error: Error) => void;
  const waiting = trackPaneSpawnEntry(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
  expect(hasPendingPaneSpawns()).toBe(true);
  fail(new Error('permit timeout'));
  await expect(waiting).rejects.toThrow('permit timeout');
  expect(hasPendingPaneSpawns()).toBe(false);
});

it('combines PTY and ACP pending startups without doubling their shared physical count', () => {
  let live = 1;
  let pending = 0;
  const undoPty = registerAgentMemoryCensus(() => ({ live, pending }), 'test-pty');
  const undoAcp = registerAgentMemoryCensus(() => ({ live, pending }), 'test-acp');
  try {
    const sample = { freeMB: 10_000, swapUsedMB: 0 };
    primeSystemMemoryCacheForTest(sample);
    live = 3; pending = 1;
    expect(getMemoryAfterAgentReservations()?.freeMB).toBe(10_000 - 2 * AGENT_PANE_FOOTPRINT_MB);
    expect(getCachedSystemMemory()).toEqual(sample);
    pending = 0;
    expect(getMemoryAfterAgentReservations()?.freeMB).toBe(10_000 - 2 * AGENT_PANE_FOOTPRINT_MB);
    primeSystemMemoryCacheForTest(sample);
    expect(getMemoryAfterAgentReservations()).toEqual(sample);
  } finally { undoPty(); undoAcp(); primeSystemMemoryCacheForTest(null); }
});

describe('uma régua de memória para todo spawn de agente: panes iniciando + builds com permit', () => {
  // Limites explícitos: o padrão escala com a RAM do host de teste.
  const env = { NEXUS_PANE_GUARD: '', NEXUS_PANE_CAP: '12', NEXUS_PANE_MIN_FREE_MB: '4000' };
  let heavyMB = 0;
  let live = 0;
  let pending = 0;
  let undoCensus = () => {};

  beforeEach(() => {
    heavyMB = 0;
    live = 0;
    pending = 0;
    registerHeavyCommandMemoryReservation(() => heavyMB);
    undoCensus = registerAgentMemoryCensus(() => ({ live, pending }), 'test-yardstick');
    registerPaneAdmissionAdvisor(null);
  });

  afterEach(() => {
    registerHeavyCommandMemoryReservation(() => 0);
    undoCensus();
    primeSystemMemoryCacheForTest(null);
  });

  it('spawn humano: o build com permit entra no aviso, que nomeia o que já foi reservado, sem recusar', () => {
    const now = Date.now();
    // Um pane ainda iniciando: a amostra (7000 MB) não o mediu.
    live = 1;
    pending = 1;
    primeSystemMemoryCacheForTest({ freeMB: 7_000, swapUsedMB: 0 }, now);
    // Sem build: 7000 - 1280 = 5720, acima do mínimo de 4000 → silêncio.
    expect(admitAgentSpawnSync(1, now, env)).toEqual({ ok: true });

    // Um build pega permit: 2048 MB do mesmo livre já têm dono.
    heavyMB = 2_048;
    const warned = admitAgentSpawnSync(1, now, env);
    expect(warned.ok).toBe(true);
    expect(warned.ok && warned.warning).toContain(
      'Memória livre baixa (3672 MB < 4000 MB; já descontados 1280 MB de panes iniciando ' +
        'e 2048 MB de builds/testes em andamento)',
    );
    // A trava dura é opt-in do operador e recusa pela mesma régua.
    expect(admitAgentSpawnSync(1, now, { ...env, NEXUS_PANE_CAP_HARD: '1' })).toMatchObject({
      ok: false,
      reason: 'memory',
    });

    // A amostra crua fica intacta; o pool de heavy-command lê a visão SEM a
    // própria reserva (ele a soma ao `neededMB`) — descontar lá seria em dobro.
    expect(getCachedSystemMemory(now)?.freeMB).toBe(7_000);
    expect(getMemoryAfterAgentReservations(now)?.freeMB).toBe(7_000 - AGENT_PANE_FOOTPRINT_MB);
    expect(getMemoryForAgentSpawn(now)?.freeMB).toBe(7_000 - AGENT_PANE_FOOTPRINT_MB - 2_048);

    // Permit solto e amostra nova depois do startup: nada a descontar.
    heavyMB = 0;
    pending = 0;
    primeSystemMemoryCacheForTest({ freeMB: 5_720, swapUsedMB: 0 }, now);
    expect(getMemoryForAgentSpawn(now)?.freeMB).toBe(5_720);
    expect(admitAgentSpawnSync(1, now, env)).toEqual({ ok: true });
  });

  it('orçamento do leque, gate do worker automático e mainPressureNow leem a mesma memória', () => {
    const now = Date.now();
    const limits = readPaneAdmissionLimits(env);
    live = 1;
    pending = 1;
    primeSystemMemoryCacheForTest({ freeMB: 4_000 + 3 * AGENT_PANE_FOOTPRINT_MB, swapUsedMB: 0 }, now);
    const read = () => ({
      budget: parallelHelperBudget({ liveAgentPanes: 1, limits, memory: getMemoryForAgentSpawn(now) }),
      verdict: admitAgentSpawnSync(1, now, env, { automaticWorker: true }),
      pressure: mainPressureNow({ limits, liveAgentPanes: () => 1, now }),
    });

    // 7840 - 1280 (pane iniciando) = 6560 → 2 vagas, e o gate admite.
    const roomy = read();
    expect(roomy.budget).toMatchObject({ slots: 2, limitedBy: 'memory', freeMB: 6_560 });
    expect(roomy.verdict.ok).toBe(true);
    expect(roomy.pressure).toBe(false);

    // Build com permit: 4512 MB não cabem mais um worker acima de 4000. O leque
    // não anuncia a vaga que o gate recusaria.
    for (const heavy of [2_048, 4_096]) {
      heavyMB = heavy;
      const tight = read();
      expect(tight.budget).toMatchObject({ slots: 0, limitedBy: 'memory' });
      expect(tight.verdict).toMatchObject({ ok: false, reason: 'memory' });
      expect(tight.pressure).toBe(true);
      if (tight.verdict.ok) return;
      expect(tight.verdict.message).toContain(
        `os livres já descontam 1280 MB de panes iniciando e ${heavy} MB de builds/testes em andamento`,
      );
    }
  });
});

describe('automatic mission worker admission', () => {
  it.each([16, 32])('enforces the existing %i GB budget and admits again after capacity returns', (gb) => {
    const limits = limitsForMachine(gb * 1024);
    const worker = (liveAgentPanes: number, freeMB: number) => evaluatePaneAdmission({
      liveAgentPanes, limits, memory: { freeMB, swapUsedMB: 9_000 },
      idleCandidates: [], automaticWorker: true,
    });
    const enough = limits.minFreeMB + 3 * AGENT_PANE_FOOTPRINT_MB;
    expect(worker(1, enough).ok).toBe(true);
    expect(worker(limits.maxAgentPanes, enough)).toMatchObject({ ok: false, reason: 'cap' });
    expect(worker(limits.maxAgentPanes - 1, enough).ok).toBe(true);
    // Merely being above the minimum is insufficient: the next child needs room.
    expect(worker(1, limits.minFreeMB + AGENT_PANE_FOOTPRINT_MB - 1)).toMatchObject({ ok: false, reason: 'memory' });
    expect(worker(1, limits.minFreeMB - 1)).toMatchObject({ ok: false, reason: 'memory' });
    expect(worker(1, limits.minFreeMB + AGENT_PANE_FOOTPRINT_MB).ok).toBe(true);
  });

  it('respects explicit resource limits, guard off, and human warning-only admission', () => {
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_CAP: '2', NEXUS_PANE_MIN_FREE_MB: '512' }, 16 * 1024);
    const atCap = input({ limits, liveAgentPanes: 2, automaticWorker: true });
    expect(evaluatePaneAdmission(atCap)).toMatchObject({ ok: false, reason: 'cap' });
    expect(evaluatePaneAdmission({ ...atCap, automaticWorker: false }).ok).toBe(true);
    expect(evaluatePaneAdmission({ ...atCap, limits: { ...limits, enabled: false }, memory: { freeMB: 1, swapUsedMB: 0 } }).ok).toBe(true);
    expect(evaluatePaneAdmission({ ...atCap, liveAgentPanes: 1, memory: null }).ok).toBe(true);
  });
});

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
    // Amostra saudável: chega ao gate sem `sysctl` e não inventa pressão.
    primeSystemMemoryCacheForTest({ freeMB: 9_000, swapUsedMB: 9_000 }, Date.now());
    const healthy = evaluatePaneAdmission(input({ memory: getCachedSystemMemory(Date.now()) }));
    expect(healthy.ok).toBe(true);
    // 12 MB livres é a máquina à beira do freeze. Até 19/10 o gate AVISAVA
    // e admitia (0.76.47); foi assim que o iMac M5 de 16 GB do cliente travou
    // inteiro. A amostra em cache continua chegando sem `sysctl` — o que
    // mudou é o veredito dela: pressão CRÍTICA agora recusa.
    primeSystemMemoryCacheForTest({ freeMB: 12, swapUsedMB: 9_000 }, Date.now());
    const verdict = evaluatePaneAdmission(
      input({ memory: getCachedSystemMemory(Date.now()) }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('memory');
    expect(verdict.message).toMatch(/cr[íi]tica/i);
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
    const limits = limitsForMachine(24 * 1024, 'darwin');
    expect(limits.minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
    expect(limits.maxSwapUsedMB).toBe(0);
    expect(limits.maxAgentPanes).toBe(12);
  });

  it('num Mac de 16 GB o teto cai para 4 (reserva de 10 GB para SO) e o mínimo disponível nunca fica abaixo de 1 GB', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(16 * 1024);
    // Otimização multi-pane 06/10: 6 panes × ~1,5 GB reais + SO + validadores
    // estouravam 16 GB e a máquina congelava. Com reserva de 10 GB o teto é 4.
    expect(limits.maxAgentPanes).toBe(4);
    expect(limits.minFreeMB).toBeGreaterThanOrEqual(1024);
  });

  it('num Mac de 12 GB o teto permanece 3 (minPanes vence o byRam da reserva ampliada)', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    expect(limitsForMachine(12 * 1024).maxAgentPanes).toBe(3);
    expect(limitsForMachine(8 * 1024).maxAgentPanes).toBe(2);
  });

  it('numa máquina de 64 GB o teto satura em 12 (o guardian, não a RAM, governa)', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    expect(limitsForMachine(64 * 1024).maxAgentPanes).toBe(12);
  });

  it('env continua sobrepondo os defaults proporcionais', async () => {
    const { readPaneAdmissionLimits } = await import('./pane-admission');
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_CAP: '3' }, 24 * 1024, 'darwin');
    expect(limits.maxAgentPanes).toBe(3);
    expect(limits.minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
  });

  it('isUnderMemoryPressure usa os mesmos limiares do gate', async () => {
    const { isUnderMemoryPressure, limitsForMachine } = await import('./pane-admission');
    const limits = limitsForMachine(24 * 1024, 'darwin');
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
    // Memória baixa mas NÃO crítica (entre 30 % e 100 % da reserva): a
    // doutrina "menos travas" segue valendo — avisa e deixa passar.
    // A reserva é a que o gate lê (os.totalmem()). 24 GB deixava 80 % dela
    // acima da reserva real neste host e o aviso não saía.
    const reserve = readPaneAdmissionLimits({}).minFreeMB;
    primeSystemMemoryCacheForTest({ freeMB: Math.round(reserve * 0.8), swapUsedMB: 0 });
    const lowMemory = admitAgentSpawnSync(0, Date.now(), {}, { agentRequested: true });
    expect(lowMemory).toMatchObject({ ok: true, warning: expect.stringContaining('Memória livre baixa') });
    // 1 MB livre é outra coisa: abrir um pane ali trava a máquina inteira.
    // Única recusa que não pede opt-in (19/10, cliente iMac M5 16 GB).
    primeSystemMemoryCacheForTest({ freeMB: 1, swapUsedMB: 0 });
    const critical = admitAgentSpawnSync(0, Date.now(), {}, { agentRequested: true });
    expect(critical.ok).toBe(false);
    // ...e as válvulas de escape continuam desligando até ela.
    expect(admitAgentSpawnSync(0, Date.now(), { NEXUS_PANE_GUARD: 'off' }).ok).toBe(true);
    expect(admitAgentSpawnSync(0, Date.now(), { NEXUS_PANE_MIN_FREE_MB: '0' }).ok).toBe(true);
  });
});

describe('pane-admission: orçamento de paralelismo da delegação (F-784)', () => {
  // Régua do Mac de referência: no Windows a reserva é menor por design
  // (o `free` não vê toda a Standby List), então o platform é explícito.
  const mac24 = limitsForMachine(24 * 1024, 'darwin'); // teto 12, mínimo livre 3.686 MB

  it('o leque inicial abre todas as partes independentes quando a máquina tem folga', async () => {
    const { helpersToOpenNow, parallelHelperBudget } = await import('./pane-admission');
    const budget = parallelHelperBudget({
      liveAgentPanes: 2,
      limits: mac24,
      memory: { freeMB: 14_000, swapUsedMB: 6_500 },
    });
    // Swap sem gate armado não pesa (pico do macOS, ver limitsForMachine).
    expect(budget).toMatchObject({ slots: 8, limitedBy: 'memory' });
    expect(helpersToOpenNow(3, budget)).toBe(3);
    expect(helpersToOpenNow(5, budget)).toBe(5);
  });

  it('acima do teto seguro abre só o que cabe — panes vivos contra o teto da RAM', async () => {
    const { helpersToOpenNow, parallelHelperBudget } = await import('./pane-admission');
    const budget = parallelHelperBudget({ liveAgentPanes: 10, limits: mac24, memory: null });
    expect(budget).toMatchObject({ slots: 2, limitedBy: 'cap', liveAgentPanes: 10, maxAgentPanes: 12 });
    expect(helpersToOpenNow(5, budget)).toBe(2);
  });

  it('incidente de 03/10: ~15 CLIs vivas não deixam abrir mais nenhuma', async () => {
    const { helpersToOpenNow, parallelHelperBudget } = await import('./pane-admission');
    const budget = parallelHelperBudget({
      liveAgentPanes: 15,
      limits: mac24,
      memory: { freeMB: 9_000, swapUsedMB: 9_200 },
    });
    expect(budget?.slots).toBe(0);
    expect(helpersToOpenNow(5, budget)).toBe(0);
  });

  it('memória disponível corta pela régua de ~1,25 GB por pane acima do mínimo livre', async () => {
    const { AGENT_PANE_FOOTPRINT_MB, parallelHelperBudget } = await import('./pane-admission');
    const twoAndHalf = mac24.minFreeMB + 2.5 * AGENT_PANE_FOOTPRINT_MB;
    expect(
      parallelHelperBudget({ liveAgentPanes: 1, limits: mac24, memory: { freeMB: twoAndHalf, swapUsedMB: 0 } }),
    ).toMatchObject({ slots: 2, limitedBy: 'memory' });
    expect(
      parallelHelperBudget({ liveAgentPanes: 1, limits: mac24, memory: { freeMB: 2_000, swapUsedMB: 0 } }),
    ).toMatchObject({ slots: 0, limitedBy: 'memory' });
  });

  it('swap só zera o orçamento onde a máquina armou o gate dela', async () => {
    const { parallelHelperBudget } = await import('./pane-admission');
    const armed = { ...mac24, maxSwapUsedMB: 4_000 };
    expect(
      parallelHelperBudget({ liveAgentPanes: 1, limits: armed, memory: { freeMB: 14_000, swapUsedMB: 9_200 } }),
    ).toMatchObject({ slots: 0, limitedBy: 'swap' });
  });

  it('guard desligado pelo operador: sem orçamento, o leque segue as partes', async () => {
    const { helpersToOpenNow, parallelHelperBudget } = await import('./pane-admission');
    const budget = parallelHelperBudget({
      liveAgentPanes: 30,
      limits: { ...mac24, enabled: false },
      memory: { freeMB: 100, swapUsedMB: 0 },
    });
    expect(budget).toBeNull();
    expect(helpersToOpenNow(4, budget)).toBe(4);
  });

  describe('plano com teto de agentes (Trial = 6): o leque guarda o Maestro e o revisor', () => {
    // ~28 vagas por memória: só o teto de panes (11 com o Maestro vivo) e a licença contam.
    const ample = { freeMB: 40_000, swapUsedMB: 0 };

    it('Trial (maxAgents 6): no máximo 4 helpers simultâneos, sobra 1 vaga para o revisor', async () => {
      const { helpersToOpenNow, parallelHelperBudget } = await import('./pane-admission');
      // Primeira onda, só o Maestro vivo. Sem o teto da licença o leque pedia 11
      // helpers, os workers ocupavam as 6 vagas e a missão travava sem revisor.
      const budget = parallelHelperBudget({
        liveAgentPanes: 1,
        limits: mac24,
        memory: ample,
        licenseMaxAgents: 6,
      });
      expect(budget).toMatchObject({ slots: 4, limitedBy: 'license', liveAgentPanes: 1, maxAgentPanes: 12 });
      expect(helpersToOpenNow(6, budget)).toBe(4);
      // Maestro + 4 helpers = 5 das 6 vagas: a sexta é do revisor independente.
      expect(1 + (budget?.slots ?? 0)).toBe(6 - 1);
    });

    it.each([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 4],
      [8, 6],
    ])('maxAgents %i → %i helper(s): reserva 2 vagas, com piso 1', async (maxAgents, helpers) => {
      const { parallelHelperBudget } = await import('./pane-admission');
      expect(
        parallelHelperBudget({ liveAgentPanes: 1, limits: mac24, memory: ample, licenseMaxAgents: maxAgents }),
      ).toMatchObject({ slots: helpers, limitedBy: 'license' });
    });

    it.each([[null], [undefined], [Number.NaN]])(
      'sem teto de agentes (%s: Pro/Team ilimitado ou leitura ausente) o orçamento é o da máquina',
      async (licenseMaxAgents) => {
        const { parallelHelperBudget } = await import('./pane-admission');
        expect(
          parallelHelperBudget({ liveAgentPanes: 1, limits: mac24, memory: ample, licenseMaxAgents }),
        ).toMatchObject({ slots: 11, limitedBy: 'cap' });
      },
    );

    it('a licença só encolhe: se a máquina já cabe menos (ou o mesmo), a razão da máquina fica', async () => {
      const { parallelHelperBudget } = await import('./pane-admission');
      // 2 vagas pelo teto de panes < 4 da licença.
      expect(
        parallelHelperBudget({ liveAgentPanes: 10, limits: mac24, memory: null, licenseMaxAgents: 6 }),
      ).toMatchObject({ slots: 2, limitedBy: 'cap' });
      // Empate (4 e 4): quem fixou o número primeiro é a máquina.
      expect(
        parallelHelperBudget({ liveAgentPanes: 8, limits: mac24, memory: null, licenseMaxAgents: 6 }),
      ).toMatchObject({ slots: 4, limitedBy: 'cap' });
      // 2 vagas por memória < 4 da licença.
      const twoAndHalf = mac24.minFreeMB + 2.5 * AGENT_PANE_FOOTPRINT_MB;
      expect(
        parallelHelperBudget({
          liveAgentPanes: 1,
          limits: mac24,
          memory: { freeMB: twoAndHalf, swapUsedMB: 0 },
          licenseMaxAgents: 6,
        }),
      ).toMatchObject({ slots: 2, limitedBy: 'memory' });
    });

    it('a licença nunca zera o orçamento: zero continua sendo só da máquina (memória, swap, guard)', async () => {
      const { parallelHelperBudget } = await import('./pane-admission');
      expect(
        parallelHelperBudget({
          liveAgentPanes: 1,
          limits: mac24,
          memory: { freeMB: 2_000, swapUsedMB: 0 },
          licenseMaxAgents: 6,
        }),
      ).toMatchObject({ slots: 0, limitedBy: 'memory' });
      expect(
        parallelHelperBudget({
          liveAgentPanes: 1,
          limits: { ...mac24, maxSwapUsedMB: 4_000 },
          memory: { freeMB: 14_000, swapUsedMB: 9_200 },
          licenseMaxAgents: 6,
        }),
      ).toMatchObject({ slots: 0, limitedBy: 'swap' });
      expect(
        parallelHelperBudget({
          liveAgentPanes: 1,
          limits: { ...mac24, enabled: false },
          memory: ample,
          licenseMaxAgents: 6,
        }),
      ).toBeNull();
    });
  });
});

describe('pane-admission: recusa de capacidade no caminho MCP (F-1270)', () => {
  it('admitToolSpawnSync usa a MESMA contagem do renderer (reserva de licença vs panes vivos)', async () => {
    const {
      admitToolSpawnSync,
      readPaneAdmissionLimits,
      primeSystemMemoryCacheForTest,
    } = await import('./pane-admission');
    primeSystemMemoryCacheForTest({ freeMB: 100_000, swapUsedMB: 0 });
    const cap = readPaneAdmissionLimits({ NEXUS_PANE_CAP_HARD: '1' }).maxAgentPanes;
    const hard = { NEXUS_PANE_CAP_HARD: '1' };

    // Worker de missão: o renderer conta `licensedAgentCount()` (reserva de
    // licença), não os panes vivos do PTY. Um pane humano extra NÃO abre vaga
    // para o worker. Era o off-by-one que deixava o MCP admitir no teto.
    expect(
      admitToolSpawnSync({
        role: 'worker', missionId: 'mission-1', operatorOpened: false,
        liveAgentPanes: 0, licensedAgentPanes: cap, env: hard,
      }),
    ).toMatchObject({ ok: false, reason: 'cap' });
    expect(
      admitToolSpawnSync({
        role: 'worker', missionId: 'mission-1', operatorOpened: false,
        liveAgentPanes: 0, licensedAgentPanes: cap - 1, env: hard,
      }).ok,
    ).toBe(true);

    // Humano (sem missão): conta os panes vivos e ignora a reserva de licença.
    expect(
      admitToolSpawnSync({
        role: undefined, missionId: undefined, operatorOpened: false,
        liveAgentPanes: cap, licensedAgentPanes: 0, env: hard,
      }),
    ).toMatchObject({ ok: false, reason: 'cap' });
    expect(
      admitToolSpawnSync({
        role: undefined, missionId: undefined, operatorOpened: false,
        liveAgentPanes: cap - 1, licensedAgentPanes: cap, env: hard,
      }).ok,
    ).toBe(true);
  });

  // F-1534: recusa por carga/admissão do Main NÃO é falha da CLI (campo 14/10:
  // 6+ workers e o gate de regressão mapeando derrubaram spawns que nasceram).
  describe('F-1534: recusa por pressão do Main não é falha da CLI', () => {
    it.each([
      ['admissão codificada do renderer', 'pane_admission_cap: Teto de 12 panes de agente atingido.', 'admission'],
      ['admissão codificada de memória', 'pane_admission_memory: Sem folga de memória.', 'admission'],
      [
        'recusa do caminho MCP (texto sem o código interno)',
        'spawn recusado pela admissão de panes (teto): Teto de 12 panes de agente atingido (12 vivos).',
        'admission',
      ],
      [
        'recusa do caminho MCP por memória',
        'spawn recusado pela admissão de panes (memória): Memória sem folga para outro worker.',
        'admission',
      ],
      ['Main encerrando PTYs', 'PTY shutdown is in progress; new sessions are blocked', 'shutdown'],
      ['teto de agentes da licença', 'license_agent_limit: 3 de 3 agentes em uso', 'license'],
      ['licença sem acesso', 'license_access_denied: sem licença ativa', 'license'],
      ['fork sem memória', 'spawn /bin/sh EAGAIN', 'os-pressure'],
      ['descritor esgotado', 'spawn /bin/sh EMFILE', 'os-pressure'],
      ['volume cheio', 'spawn /bin/sh ENOSPC', 'os-pressure'],
      ['reset de conexão sob carga', 'read ECONNRESET', 'os-pressure'],
    ])('%s → pressão (não CLI)', (_label, error, kind) => {
      const parsed = parseMainPressureRefusal(new Error(error));
      expect(parsed?.kind).toBe(kind);
      // A mensagem real viaja: o aviso ao Maestro nomeia o motivo da máquina.
      expect(parsed?.message.length).toBeGreaterThan(0);
    });

    it.each([
      'Qwen Code: modelo selado "qwen3.7-plus" não entrou no argv do spawn',
      'claude: missing absolute binary path for spawn (adapter.bin=claude)',
      'Codex not found on PATH. Install: npm i -g @openai/codex',
      'native_deferred_spawn_context_changed',
      '',
    ])('recusa da própria CLI NÃO vira pressão: %s', (error) => {
      expect(parseMainPressureRefusal(new Error(error))).toBeNull();
    });

    it('mainPressureNow só fecha com folga zero (teto, memória ou Main ocupado)', () => {
      // Limites explícitos: a régua de memória padrão escala com a RAM da
      // máquina de teste e o número não pode depender do host.
      const limits: PaneAdmissionLimits = {
        ...readPaneAdmissionLimits({ NEXUS_PANE_GUARD: 'hard', NEXUS_PANE_CAP: '4' }),
        minFreeMB: 4_000,
        maxSwapUsedMB: 0,
      };
      let live = 0;
      const undo = registerAgentMemoryCensus(() => ({ live, pending: 0 }), 'test-pressure');
      try {
        primeSystemMemoryCacheForTest({ freeMB: 10_000, swapUsedMB: 0 });
        expect(mainPressureNow({ limits, liveAgentPanes: () => live })).toBe(false);
        // Sem vaga de pane, mesmo com folga de sobra.
        live = 4;
        expect(mainPressureNow({ limits, liveAgentPanes: () => live })).toBe(true);
        // Com memória no fim, um pane abaixo do teto também fecha.
        primeSystemMemoryCacheForTest({ freeMB: 512, swapUsedMB: 0 });
        live = 1;
        expect(mainPressureNow({ limits, liveAgentPanes: () => live })).toBe(true);
      } finally {
        undo();
        primeSystemMemoryCacheForTest(null);
      }
    });

    it('guard desligado não fecha por pressão (o gate avisa, não trava)', () => {
      const limits = readPaneAdmissionLimits({ NEXUS_PANE_GUARD: 'off' });
      expect(mainPressureNow({ limits, liveAgentPanes: () => 99 })).toBe(false);
    });
  });

  it('o erro codificado sobrevive ao Error.message e a mensagem real volta', async () => {
    const { paneAdmissionRefusalError, parsePaneAdmissionRefusal } = await import('./pane-admission');
    const message = 'Teto de 12 panes de agente atingido (12 vivos). Feche os que entregaram.';
    const coded = paneAdmissionRefusalError('cap', message);
    expect(coded).toBe(`pane_admission_cap: ${message}`);
    // O ACK pendente do spawn só retém Error.message: a recusa volta por lá.
    expect(parsePaneAdmissionRefusal(new Error(coded))).toEqual({
      reason: 'cap',
      message,
    });
    expect(parsePaneAdmissionRefusal('pane_admission_memory: Sem folga de memória.')).toEqual({
      reason: 'memory',
      message: 'Sem folga de memória.',
    });
    // Recusa da própria CLI (modelo selado etc.) não é capacidade.
    expect(parsePaneAdmissionRefusal(new Error('Qwen Code: modelo selado "qwen3.7-plus"'))).toBeNull();
    expect(parsePaneAdmissionRefusal(undefined)).toBeNull();
  });
});

describe('pane-admission: Windows 32 GB (cliente 15/10) — standby/cache não trava o 3º worker', () => {
  it('a reserva padrão para de crescer linearmente: 32/64 GB não exigem 4,9/9,8 GB livres', async () => {
    const { limitsForMachine } = await import('./pane-admission');
    // Régua não-win32 (POSIX): a reserva win32 é menor por design, então os
    // asserts POSIX passam a plataforma explícita — sem isso herdam o win32 real.
    expect(limitsForMachine(32 * 1024, 'darwin').minFreeMB).toBe(4096);
    expect(limitsForMachine(64 * 1024, 'darwin').minFreeMB).toBe(4096);
    // 24 GB (referência Mac) segue em 15 %: abaixo do teto, nada muda.
    expect(limitsForMachine(24 * 1024, 'darwin').minFreeMB).toBe(Math.round(0.15 * 24 * 1024));
    // win32: `free` não vê toda a Standby List → reserva (e percentual) menores.
    expect(limitsForMachine(32 * 1024, 'win32').minFreeMB).toBe(2048);
    expect(limitsForMachine(64 * 1024, 'win32').minFreeMB).toBe(2048);
    expect(limitsForMachine(16 * 1024, 'win32').minFreeMB).toBe(1311);
    // O piso de 1 GB e o teto de panes seguem intactos.
    expect(limitsForMachine(8 * 1024, 'win32').minFreeMB).toBe(1024);
    expect(limitsForMachine(32 * 1024, 'win32').maxAgentPanes).toBe(12);
  });

  it('cenário do cliente: 32 GB, 2 panes vivos, 3º worker automático admitido', () => {
    const limits = limitsForMachine(32 * 1024, 'win32');
    // Antes: reserva de 15 % (4.915 MB) + 1.280 MB do worker exigiam ≥ 6.195 MB
    // "livres" medidos sem standby — e ainda debitava 1.280 MB por pane não
    // medido. Agora a amostra corrigida (maior entre free/os.freemem/available)
    // e a reserva de 2.048 MB admitem o 3º worker com ~7 GB disponíveis.
    const verdict = evaluatePaneAdmission({
      liveAgentPanes: 2,
      limits,
      memory: { freeMB: 7 * 1024, swapUsedMB: null },
      idleCandidates: [],
      automaticWorker: true,
    });
    expect(verdict.ok).toBe(true);
    // Sem folga REAL continua recusando — e a mensagem nomeia o medido vs a
    // reserva e deixa claro que é memória RAM, não limite do plano.
    const blocked = evaluatePaneAdmission({
      liveAgentPanes: 2,
      limits,
      memory: { freeMB: limits.minFreeMB + AGENT_PANE_FOOTPRINT_MB - 1, swapUsedMB: null },
      idleCandidates: [],
      automaticWorker: true,
    });
    expect(blocked).toMatchObject({ ok: false, reason: 'memory' });
    if (blocked.ok) return;
    expect(blocked.message).toContain('MB livres medidos');
    expect(blocked.message).toContain('não limite do plano');
  });

  it('sampleSystemMemory no win32 usa o maior entre free, os.freemem e available', async () => {
    const { sampleSystemMemory } = await import('./pane-admission');
    const sample = await sampleSystemMemory('win32', {
      readElectron: () => ({ free: 2_048 * 1024, available: 9_216 * 1024 }),
      freemem: () => 7 * 1024 ** 3,
    });
    expect(sample).toEqual({ freeMB: 9_216, swapUsedMB: null });
    const fallback = await sampleSystemMemory('win32', {
      readElectron: () => ({ free: 3_072 * 1024 }),
      freemem: () => 2 * 1024 ** 3,
    });
    expect(fallback).toEqual({ freeMB: 3_072, swapUsedMB: null });
  });

  it('refresh não debita pane cuja inicialização terminou antes da leitura da amostra', async () => {
    const { refreshSystemMemorySample } = await import('./pane-admission');
    let live = 0;
    let pending = 0;
    const undo = registerAgentMemoryCensus(() => ({ live, pending }), 'test-win32');
    try {
      await refreshSystemMemorySample({
        platform: 'win32',
        // Pane inicializado DURANTE a janela assíncrona da amostra: a leitura
        // acontece depois dele, então seu footprint já está medido — sem a
        // dupla contagem de 1.280 MB que recusava o 3º worker do cliente.
        readElectron: () => {
          live = 2;
          pending = 0;
          return { free: 10_000 * 1024 };
        },
        freemem: () => 10_000 * 1024 ** 2,
      });
      expect(getMemoryAfterAgentReservations()?.freeMB).toBe(10_000);
    } finally {
      undo();
      primeSystemMemoryCacheForTest(null);
    }
  });
});
