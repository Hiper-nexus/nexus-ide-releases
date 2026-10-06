import { afterEach, expect, it, vi } from 'vitest';
import { HeavyCommandPermitPool, heavyCommandReserveMB } from './heavy-command-permit';
import { testProjectScope } from './__tests__/scope-fixture';

const pools: HeavyCommandPermitPool[] = [];
const scope = testProjectScope();
const request = (projectId = scope.projectId) => ({ scope: { ...scope, projectId }, missionId: 'mission',
  sessionId: 'worker', kind: 'typescript' as const });
function pool(memory: () => { freeMB: number | null; swapUsedMB: number | null } | null = () => ({ freeMB: 20_000, swapUsedMB: 0 })) {
  const value = new HeavyCommandPermitPool({ memory, limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 100, maxWaiters: 2, reserveMB: 1000 });
  pools.push(value); return value;
}
afterEach(() => { for (const value of pools.splice(0)) value.close(); vi.useRealTimers(); });

it('com memória de sobra o mesmo projeto abre 2 vagas; projetos independentes seguem livres', async () => {
  // freeMB 20_000 é de sobra para minFree 1000 + 2×1000 + headroom 1024.
  const value = pool(); const first = await value.acquire(request());
  let admitted = false;
  const second = value.acquire({ ...request(), scope: { ...scope, checkoutId: 'worker-checkout', rootRealPath: '/isolated' } }).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(true); // 2ª vaga do MESMO projeto
  const other = await value.acquire(request('another-project'));
  expect(value.snapshot().active).toBe(3);
  first.release(); (await second).release(); other.release();
  expect(value.snapshot().active).toBe(0);
});

it('sob pressão de memória o mesmo projeto volta a 1 vaga (a fila protege a máquina)', async () => {
  // Livre o bastante para 1 reserva (1000+1000) mas sem headroom para a 2ª.
  const value = pool(() => ({ freeMB: 2_100, swapUsedMB: 0 }));
  const first = await value.acquire(request());
  let admitted = false;
  const second = value.acquire(request()).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false);
  first.release(); (await second).release();
});

it('serializa além da 2ª vaga do projeto: a 3ª espera a liberação', async () => {
  const value = pool();
  const first = await value.acquire(request());
  const second = await value.acquire(request());
  let thirdAdmitted = false;
  const third = value.acquire(request()).then(p => { thirdAdmitted = true; return p; });
  await Promise.resolve(); expect(thirdAdmitted).toBe(false);
  first.release(); const thirdPermit = await third; expect(thirdAdmitted).toBe(true);
  second.release(); thirdPermit.release();
});

it('worktree compartilha o orçamento do projeto (não ganha vaga própria)', async () => {
  const value = pool(() => ({ freeMB: 2_100, swapUsedMB: 0 })); // só 1 vaga
  const first = await value.acquire(request());
  let worktreeAdmitted = false;
  const worktree = value.acquire({ ...request(), scope: { ...scope, checkoutId: 'wt', rootRealPath: '/isolated' } })
    .then(p => { worktreeAdmitted = true; return p; });
  await Promise.resolve(); expect(worktreeAdmitted).toBe(false);
  first.release(); (await worktree).release();
});

it('reserva por tipo: tsc/tests 1024 MB, build/install 2048 MB', () => {
  expect(heavyCommandReserveMB('typescript')).toBe(1024);
  expect(heavyCommandReserveMB('tests')).toBe(1024);
  expect(heavyCommandReserveMB('build')).toBe(2048);
  expect(heavyCommandReserveMB('install')).toBe(2048);
  expect(heavyCommandReserveMB('build', 4096)).toBe(4096);
});

it('com waitMs injetado (teste) missão e helper compartilham o prazo do pool', async () => {
  vi.useFakeTimers();
  const value = new HeavyCommandPermitPool({
    memory: () => ({ freeMB: 100, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }),
    refreshMemory: async () => {}, pollMs: 10, waitMs: 200, maxWaiters: 4, reserveMB: 1000,
  });
  pools.push(value);
  const missionWait = expect(value.acquire({ ...request(), missionId: 'm' })).rejects.toThrow('wait_timeout');
  const helperWait = expect(value.acquire({ ...request(), missionId: undefined })).rejects.toThrow('wait_timeout');
  await vi.advanceTimersByTimeAsync(210);
  await helperWait;
  await missionWait;
});

it('produção (sem waitMs): missão espera 15 min, helper solto 5 min', async () => {
  vi.useFakeTimers();
  const value = new HeavyCommandPermitPool({
    memory: () => ({ freeMB: 100, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }),
    refreshMemory: async () => {}, pollMs: 10, maxWaiters: 4, reserveMB: 1000,
  });
  pools.push(value);
  const missionWait = expect(value.acquire({ ...request(), missionId: 'm' })).rejects.toThrow('wait_timeout');
  const helperWait = expect(value.acquire({ ...request(), missionId: undefined })).rejects.toThrow('wait_timeout');
  // Helper solto: 300 s.
  await vi.advanceTimersByTimeAsync(300_001);
  await helperWait;
  // Missão ainda esperando aos 300 s.
  let missionSettled = false;
  void missionWait.then(() => { missionSettled = true; }, () => { missionSettled = true; });
  await Promise.resolve();
  expect(missionSettled).toBe(false);
  // 15 min totais.
  await vi.advanceTimersByTimeAsync(600_000);
  await missionWait;
});

it('cancels queued commands and keeps an active reservation through caller cancellation', async () => {
  // Memória apertada: 1 vaga por projeto, então o segundo fica na fila.
  const value = pool(() => ({ freeMB: 2_100, swapUsedMB: 0 }));
  const activeController = new AbortController();
  const active = await value.acquire({ ...request(), signal: activeController.signal });
  const cancelled = new AbortController();
  const waiting = value.acquire({ ...request(), signal: cancelled.signal });
  const rejected = expect(waiting).rejects.toThrow('aborted'); cancelled.abort(); await rejected;
  activeController.abort(); expect(value.snapshot().active).toBe(1);
  active.release(); active.release(); expect(value.snapshot().active).toBe(0);
});

it('reserves RAM atomically across projects and admits after physical release', async () => {
  // 2500 livres: cabe a reserva de tsc (1024) + minFree 1000, mas não a 2ª.
  const value = pool(() => ({ freeMB: 2500, swapUsedMB: 99999 })); // stale swap peak is not pressure by default
  const first = await value.acquire(request()); let admitted = false;
  const second = value.acquire(request('second')).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false);
  // kind 'typescript' reserva 1024 (não o fallback do pool).
  expect(value.snapshot().reservedMB).toBe(1024);
  first.release(); (await second).release();
});

it('does not let stale authority consume the next slot and bounds its waiting queue', async () => {
  // Memória apertada: 1 vaga; dois waiters enchem o maxWaiters: 2.
  const value = pool(() => ({ freeMB: 2_100, swapUsedMB: 0 }));
  const first = await value.acquire(request()); let current = true;
  const stale = value.acquire({ ...request(), isCurrent: () => current });
  const staleResult = expect(stale).rejects.toThrow('authority');
  const last = value.acquire(request());
  await expect(value.acquire(request())).rejects.toThrow('queue_full');
  current = false; first.release(); await staleResult; (await last).release();
});

it('expires a pressure-blocked waiter without starting work, and closes queued work', async () => {
  vi.useFakeTimers(); const value = pool(() => ({ freeMB: 100, swapUsedMB: 0 }));
  const pending = value.acquire(request()); const expired = expect(pending).rejects.toThrow('wait_timeout');
  await vi.advanceTimersByTimeAsync(110); await expired; expect(value.snapshot().active).toBe(0);
  const second = value.acquire(request()); const closed = expect(second).rejects.toThrow('closed'); value.close(); await closed;
});

it('uses one machine slot when RAM is unknown', async () => {
  const value = pool(() => null); const first = await value.acquire(request()); let admitted = false;
  const second = value.acquire(request('another')).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false); first.release(); (await second).release();
});

it('queues Main-owned loose helpers without a mission, including direct assistant tools', async () => {
  // Memória apertada: 1 vaga; o helper solto ocupa e o assistente espera.
  const value = pool(() => ({ freeMB: 2_100, swapUsedMB: 0 }));
  const helper = await value.acquire({ ...request(), missionId: undefined });
  expect(helper.id).not.toBe('');
  let admitted = false;
  const assistant = value.acquire({ ...request(), missionId: undefined, sessionId: undefined }).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false);
  helper.release(); (await assistant).release();
});
