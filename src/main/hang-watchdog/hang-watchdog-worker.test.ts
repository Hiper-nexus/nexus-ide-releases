import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HangWatchdogConfig, HangProfileFrame } from './hang-watchdog-logic';

/**
 * A worker é JS puro embutido verbatim; aqui o MESMO arquivo entra como
 * módulo para as funções puras e para a máquina de estados com relógio, fs e
 * inspector falsos. A prova com Worker e inspector reais está em
 * main-thread-hang-watchdog.test.ts.
 */
interface ProfileSummary {
  sampleCount: number;
  durationMs: number | null;
  topFrames: HangProfileFrame[];
}
interface FakeSession {
  post: (method: string, params: unknown, cb: (error: Error | null, result?: unknown) => void) => void;
  disconnect: () => void;
}
interface WatchdogDeps {
  config: HangWatchdogConfig;
  now: () => number;
  fs: ReturnType<typeof memoryFs>;
  joinPath: (dir: string, name: string) => string;
  openInspectorSession: () => FakeSession;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  notify: (message: unknown) => void;
}
interface WorkerModule {
  summarizeCpuProfile: (profile: unknown, options?: { limit?: number; stackDepth?: number }) => ProfileSummary;
  planProfileRetention: (
    entries: Array<{ name: string; size: number }>,
    policy: { keep: number; maxTotalBytes: number },
  ) => string[];
  profileFileName: (at: number) => string;
  createHangWatchdog: (deps: WatchdogDeps) => {
    handleMessage: (message: unknown) => void;
    check: () => void;
  };
}

const worker = createRequire(import.meta.url)('./hang-watchdog-worker.cjs') as WorkerModule;

const T0 = Date.UTC(2026, 9, 3, 11, 41, 37);

function frame(functionName: string, lineNumber = 0, columnNumber = 0) {
  return { functionName, url: 'file:///app/main.js', lineNumber, columnNumber, scriptId: '1' };
}

/** (root) → fireTaps → detectLimit (6) | stripAnsi (3); (program) 1; (idle) 2. */
function sampleProfile() {
  return {
    nodes: [
      { id: 1, callFrame: { ...frame('(root)', -1, -1), url: '' }, children: [2, 5, 6] },
      { id: 2, callFrame: frame('fireTaps', 9, 4), children: [3, 4] },
      { id: 3, callFrame: frame('detectLimit', 99, 0) },
      { id: 4, callFrame: frame('stripAnsi', 199, 2) },
      { id: 5, callFrame: { ...frame('(program)', -1, -1), url: '' } },
      { id: 6, callFrame: { ...frame('(idle)', -1, -1), url: '' } },
    ],
    samples: [3, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6],
    startTime: 1_000_000,
    endTime: 4_000_000,
  };
}

function memoryFs() {
  const files = new Map<string, string>();
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    files,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((file: string, data: string) => {
      files.set(file, String(data));
    }),
    appendFileSync: vi.fn((file: string, data: string) => {
      files.set(file, (files.get(file) ?? '') + String(data));
    }),
    statSync: vi.fn((file: string) => {
      const content = files.get(file);
      if (content === undefined) throw enoent();
      return { size: Buffer.byteLength(content) };
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw enoent();
      files.set(to, content);
      files.delete(from);
    }),
    readdirSync: vi.fn((dir: string) =>
      [...files.keys()].filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1)),
    ),
    unlinkSync: vi.fn((file: string) => {
      files.delete(file);
    }),
  };
}

function fakeSession(options: { profile?: unknown; respond?: boolean; failOn?: string } = {}) {
  const calls: Array<[string, unknown]> = [];
  const session = {
    post: vi.fn((method: string, params: unknown, cb: (error: Error | null, result?: unknown) => void) => {
      calls.push([method, params]);
      if (options.respond === false) return;
      queueMicrotask(() => {
        if (options.failOn === method) cb(new Error(`${method} recusado`));
        else cb(null, method === 'Profiler.stop' ? { profile: options.profile ?? sampleProfile() } : {});
      });
    }),
    disconnect: vi.fn(),
  };
  return { session, calls };
}

const BASE_CONFIG: HangWatchdogConfig = {
  logsDir: '/logs',
  version: '9.9.9',
  thresholdMs: 1_000,
  checkIntervalMs: 100,
  remarkEveryMs: 5_000,
  historyRotateBytes: 1_000_000,
  profileDurationMs: 300,
  samplingIntervalUs: 500,
  inspectorTimeoutMs: 2_000,
  maxProfiles: 2,
  maxProfilesTotalBytes: 1_000_000_000,
  maxProfileBytes: 1_000_000_000,
  topFrames: 3,
  stackDepth: 4,
};

function harness(
  overrides: Partial<HangWatchdogConfig> = {},
  inspector: { session: FakeSession } | (() => FakeSession) = fakeSession(),
) {
  const fs = memoryFs();
  const notify = vi.fn();
  const open: () => FakeSession =
    typeof inspector === 'function' ? inspector : () => inspector.session;
  const openInspectorSession = vi.fn(open);
  const watchdog = worker.createHangWatchdog({
    config: { ...BASE_CONFIG, ...overrides },
    now: () => Date.now(),
    fs,
    joinPath: (dir, name) => `${dir}/${name}`,
    openInspectorSession,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    notify,
  });
  const records = (): Array<Record<string, unknown>> =>
    (fs.files.get('/logs/main-hang.ndjson') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const profileFiles = () => [...fs.files.keys()].filter((file) => file.endsWith('.cpuprofile')).sort();
  return { fs, notify, watchdog, records, profileFiles, openInspectorSession };
}

/** Avança o relógio rodando o `check()` no ritmo da worker real. */
async function runChecks(watchdog: { check: () => void }, totalMs: number, stepMs = 100): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    watchdog.check();
  }
}

describe('summarizeCpuProfile', () => {
  it('ordena por amostras próprias, ignora (root)/(idle) e devolve linha/coluna 1-based com a pilha', () => {
    const summary = worker.summarizeCpuProfile(sampleProfile(), { limit: 5, stackDepth: 4 });
    expect(summary.sampleCount).toBe(12);
    expect(summary.durationMs).toBe(3_000);
    expect(summary.topFrames.map((f) => f.functionName)).toEqual(['detectLimit', 'stripAnsi', '(program)']);
    expect(summary.topFrames[0]).toEqual({
      functionName: 'detectLimit',
      url: 'file:///app/main.js',
      line: 100,
      column: 1,
      selfSamples: 6,
      selfPercent: 50,
      stack: ['fireTaps main.js:10:5'],
    });
  });

  it('soma a mesma função vinda de caminhos diferentes e mostra a pilha do mais pesado', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2, 3] },
        { id: 2, callFrame: frame('onSessionData', 1, 1), children: [4] },
        { id: 3, callFrame: frame('reconcile', 2, 1), children: [5] },
        { id: 4, callFrame: frame('detectLimit', 99) },
        { id: 5, callFrame: frame('detectLimit', 99) },
      ],
      samples: [4, 5, 5, 5],
    };
    const [top] = worker.summarizeCpuProfile(profile).topFrames;
    expect(top).toMatchObject({ functionName: 'detectLimit', selfSamples: 4, selfPercent: 100 });
    expect(top?.stack).toEqual(['reconcile main.js:3:2']);
  });

  it('cai no hitCount sem `samples` e tolera profile malformado', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2], hitCount: 0 },
        { id: 2, callFrame: frame('hot'), hitCount: 7 },
      ],
    };
    expect(worker.summarizeCpuProfile(profile).topFrames[0]).toMatchObject({ functionName: 'hot', selfSamples: 7 });
    expect(worker.summarizeCpuProfile(null)).toEqual({ sampleCount: 0, durationMs: null, topFrames: [] });
    expect(worker.summarizeCpuProfile({ nodes: 'x', samples: [9] }).topFrames).toEqual([]);
  });
});

describe('retenção dos .cpuprofile', () => {
  const name = (minute: number) => worker.profileFileName(T0 + minute * 60_000);

  it('nome ordenável por data, sem `:` (seguro em qualquer sistema de arquivos)', () => {
    expect(name(0)).toBe('main-hang-2026-10-03T11-41-37-000Z.cpuprofile');
    expect(name(0) < name(1)).toBe(true);
  });

  it('mantém os N mais recentes e nunca toca arquivo de fora do padrão', () => {
    const entries = [0, 1, 2, 3].map((m) => ({ name: name(m), size: 10 }));
    entries.push({ name: 'main-hang.ndjson', size: 10 }, { name: 'main.trace.ndjson', size: 10 });
    expect(worker.planProfileRetention(entries, { keep: 2, maxTotalBytes: 1_000 }).sort()).toEqual(
      [name(0), name(1)].sort(),
    );
  });

  it('respeita o teto total, mas o mais recente fica sempre', () => {
    const entries = [
      { name: name(0), size: 40 },
      { name: name(1), size: 40 },
      { name: name(2), size: 500 },
    ];
    expect(worker.planProfileRetention(entries, { keep: 5, maxTotalBytes: 100 }).sort()).toEqual(
      [name(0), name(1)].sort(),
    );
  });
});

describe('createHangWatchdog (máquina de estados da worker)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sem heartbeat ainda (boot) não marca nada', async () => {
    const h = harness();
    await runChecks(h.watchdog, 5_000);
    expect(h.records()).toEqual([]);
    expect(h.openInspectorSession).not.toHaveBeenCalled();
  });

  it('gap acima do limiar: marca com o último event-loop, captura UMA vez e fecha o episódio', async () => {
    const inspector = fakeSession();
    const h = harness({}, inspector);
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    h.watchdog.handleMessage({ type: 'event-loop', summary: { p99Ms: 420, maxMs: 1800 } });
    const runtimeContext = { sampledAt: Date.now(), events: [{ kind: 'agent-pty-exit' }],
      periodic: { tasks: [{ name: 'delegation-supervisor', running: 1 }] }, analysis: { outputBytesPerSecond: 5_000_000 } };
    h.watchdog.handleMessage({ type: 'runtime-context', context: runtimeContext });

    await runChecks(h.watchdog, 1_000);
    expect(h.records()).toEqual([]);

    await runChecks(h.watchdog, 100);
    const [hang] = h.records();
    expect(hang).toMatchObject({
      kind: 'main-thread-hang',
      appVersion: '9.9.9',
      lastHeartbeatAt: T0,
      eventLoop: { p99Ms: 420, maxMs: 1800 },
    });
    expect(hang?.hangDurationMs).toBeGreaterThan(1_000);
    expect(h.fs.files.get('/logs/main-hang-marker.json')).toContain('"main-thread-hang"');

    // A captura roda (enable → intervalo → start → espera → stop) e grava o profile.
    await runChecks(h.watchdog, 600);
    expect(inspector.calls.map(([method]) => method)).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
      'Profiler.stop',
    ]);
    expect(inspector.calls[1]?.[1]).toEqual({ interval: 500 });
    expect(h.records().find(record => record.kind === 'main-thread-hang')?.runtimeContext).toEqual(runtimeContext);
    expect(inspector.session.disconnect).toHaveBeenCalledTimes(1);
    const profileRecord = h.records().find((r) => r.kind === 'main-thread-hang-profile');
    expect(profileRecord).toMatchObject({
      kind: 'main-thread-hang-profile',
      lastHeartbeatAt: T0,
      sampleCount: 12,
      profileDurationMs: 3_000,
    });
    expect((profileRecord?.topFrames as HangProfileFrame[] | undefined)?.[0]?.functionName).toBe('detectLimit');
    expect(h.profileFiles()).toEqual([`/logs/${profileRecord?.profileFile as string}`]);
    expect(JSON.parse(h.fs.files.get(h.profileFiles()[0]!)!)).toEqual(sampleProfile());

    // Mais checagens no MESMO episódio: nenhuma captura nova.
    await runChecks(h.watchdog, 3_000);
    expect(h.openInspectorSession).toHaveBeenCalledTimes(1);

    // Heartbeat de volta fecha o episódio com a duração medida.
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    const recovered = h.records().at(-1);
    expect(recovered).toMatchObject({ kind: 'main-thread-hang-recovered', lastHeartbeatAt: T0 });
    expect(recovered?.hangDurationMs).toBe(Date.now() - T0);

    // O main recebe cada linha (vira main.trace.ndjson quando ele voltar).
    expect(h.notify.mock.calls.map(([message]) => (message as { record: { kind: string } }).record.kind)).toEqual([
      'main-thread-hang',
      'main-thread-hang-profile',
      'main-thread-hang-recovered',
    ]);
  });

  it('episódio longo remarca a duração no máximo a cada remarkEveryMs, sem segunda captura', async () => {
    const h = harness({ remarkEveryMs: 2_000 });
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 6_000);
    const hangs = h.records().filter((r) => r.kind === 'main-thread-hang');
    expect(hangs).toHaveLength(3);
    expect(hangs.map((r) => r.hangDurationMs as number)).toEqual([...hangs.map((r) => r.hangDurationMs as number)].sort((a, b) => a - b));
    expect(h.openInspectorSession).toHaveBeenCalledTimes(1);
  });

  it('novo episódio depois da volta captura de novo e a retenção apaga o mais antigo', async () => {
    const h = harness({ maxProfiles: 2 });
    for (let episode = 0; episode < 3; episode += 1) {
      h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
      await runChecks(h.watchdog, 2_000);
    }
    expect(h.openInspectorSession).toHaveBeenCalledTimes(3);
    const written = h.records().filter((r) => r.kind === 'main-thread-hang-profile').map((r) => `/logs/${r.profileFile as string}`);
    expect(written).toHaveLength(3);
    expect(h.profileFiles()).toEqual(written.slice(1));
  });

  it('inspector indisponível vira profilerUnavailable com o motivo e o watchdog segue', async () => {
    const h = harness({}, () => {
      throw new Error('inspector desligado neste build');
    });
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 1_500);
    const record = h.records().find((r) => r.kind === 'main-thread-hang-profile');
    expect(record).toMatchObject({ profilerUnavailable: 'inspector desligado neste build' });
    expect(record).not.toHaveProperty('profileFile');
    expect(h.profileFiles()).toEqual([]);
    // Segue vigiando: a volta do heartbeat ainda fecha o episódio.
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    expect(h.records().at(-1)?.kind).toBe('main-thread-hang-recovered');
  });

  it('main que não atende o inspector (presa fora do JS) desiste no prazo e desconecta', async () => {
    const inspector = fakeSession({ respond: false });
    const h = harness({ profileDurationMs: 300, inspectorTimeoutMs: 2_000 }, inspector);
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 1_100);
    expect(h.records().some((r) => r.kind === 'main-thread-hang-profile')).toBe(false);
    await runChecks(h.watchdog, 2_400);
    const record = h.records().find((r) => r.kind === 'main-thread-hang-profile');
    expect(record?.profilerUnavailable).toMatch(/não atendeu o inspector em 2 s/);
    expect(inspector.session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('comando recusado pelo inspector também vira profilerUnavailable', async () => {
    const h = harness({}, fakeSession({ failOn: 'Profiler.start' }));
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 1_500);
    expect(h.records().find((r) => r.kind === 'main-thread-hang-profile')).toMatchObject({
      profilerUnavailable: 'Profiler.start recusado',
    });
  });

  it('profile acima do teto não vai para o disco, mas o resumo sai', async () => {
    const h = harness({ maxProfileBytes: 100 });
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 1_600);
    const record = h.records().find((r) => r.kind === 'main-thread-hang-profile');
    expect(record).toMatchObject({ profileFile: null, profileSkipped: 'acima de 100 bytes' });
    expect((record?.topFrames as HangProfileFrame[] | undefined)?.[0]?.functionName).toBe('detectLimit');
    expect(h.profileFiles()).toEqual([]);
  });

  it('worker parada junto (Mac dormindo) não acusa a main: recomeça a contagem', async () => {
    const h = harness();
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    h.watchdog.check();
    // Nem a worker rodou por 10 s: o gap é do sistema, não da main.
    await vi.advanceTimersByTimeAsync(10_000);
    h.watchdog.check();
    expect(h.records()).toEqual([]);
    // Main saudável manda heartbeat logo em seguida: nada a marcar.
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 500);
    expect(h.records()).toEqual([]);
    // Main presa de verdade depois da volta: o gap cresce de novo e é pego.
    await runChecks(h.watchdog, 1_200);
    expect(h.records()[0]?.kind).toBe('main-thread-hang');
  });

  it('histórico gira acima do teto e ignora mensagens estranhas do canal', async () => {
    const h = harness({ historyRotateBytes: 50 });
    h.fs.files.set('/logs/main-hang.ndjson', 'x'.repeat(60));
    h.watchdog.handleMessage(null);
    h.watchdog.handleMessage({ type: 'heartbeat', at: 'ontem' });
    h.watchdog.handleMessage({ type: 'heartbeat', at: Date.now() });
    await runChecks(h.watchdog, 1_100);
    expect(h.fs.files.get('/logs/main-hang.ndjson.1')).toBe('x'.repeat(60));
    expect(h.records()[0]?.kind).toBe('main-thread-hang');
  });
});
