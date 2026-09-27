import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegressionGateResult } from '../regression-gate/regression-gate';
import type { GitRunner } from '../runtime/git-command';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  adoptUserSessionAsMissionOrchestrator,
  bindTokenToSession,
  getContextBySession,
  mintToken,
  resetGateForTests,
} from './gate';
import {
  __resetHookRegressionForTests,
  handleHookRegressionRequest,
  MAX_CONSECUTIVE_STOP_BLOCKS,
  STOP_HOOK_BUDGET_MS,
} from './hook-regression-endpoint';
import {
  REGRESSION_HOOK_TIMEOUT_SECONDS,
  REGRESSION_HOOK_TRANSPORT_SECONDS,
} from './hook-regression-command';

const scope = testProjectScope();
const git: GitRunner = {
  run: () => ({ status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }),
} as unknown as GitRunner;

function result(partial: Partial<RegressionGateResult>): RegressionGateResult {
  return {
    version: 'regression-gate-v1',
    status: 'passed',
    diffHash: 'hash-1',
    headSha: null,
    baseSha: null,
    baseSource: null,
    changedFiles: ['src/a.ts'],
    testsRun: ['src/a.test.ts'],
    testsNotRun: [],
    failures: [],
    inheritedFailures: [],
    untestedFiles: [],
    invariantsTouched: [],
    runner: 'vitest',
    warnings: [],
    cached: false,
    durationMs: 1,
    ...partial,
  };
}

const operator = { role: 'user' as const, sessionId: 'op-1', scope };
const failed = result({
  status: 'failed',
  failures: [{ file: 'src/b.test.ts', message: 'soma: expected 2 to be 3' }],
});

afterEach(() => {
  __resetHookRegressionForTests();
  resetGateForTests();
});

describe('handleHookRegressionRequest (Stop do pane do operador)', () => {
  it('diff que quebra teste impactado bloqueia o fim do turno com as falhas', async () => {
    const run = vi.fn(async () => failed);
    const response = await handleHookRegressionRequest(operator, {}, { run, git, enabled: () => true });
    expect(response.payload).toMatchObject({ decision: 'block' });
    expect(String(response.payload.reason)).toContain('Seu diff quebrou 1');
    expect(String(response.payload.reason)).toContain('src/b.test.ts');
  });

  it('o mesmo diff é relatado uma vez só (sem laço de Stop)', async () => {
    const run = vi.fn(async () => failed);
    const deps = { run, git, enabled: () => true };
    await handleHookRegressionRequest(operator, {}, deps);
    const second = await handleHookRegressionRequest(operator, {}, deps);
    expect(second.payload).toEqual({});
  });

  it(`no máximo ${MAX_CONSECUTIVE_STOP_BLOCKS} bloqueios seguidos sem um verde`, async () => {
    let n = 0;
    const run = vi.fn(async () => ({ ...failed, diffHash: `hash-${(n += 1)}` }));
    const deps = { run, git, enabled: () => true };
    const decisions: unknown[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_STOP_BLOCKS + 1; i += 1) {
      decisions.push((await handleHookRegressionRequest(operator, {}, deps)).payload.decision);
    }
    expect(decisions).toEqual([
      ...Array.from({ length: MAX_CONSECUTIVE_STOP_BLOCKS }, () => 'block'),
      undefined,
    ]);
  });

  it('verde sem aviso fica calado; área sem teste vira aviso sem bloquear', async () => {
    const quiet = await handleHookRegressionRequest(
      operator,
      {},
      { run: async () => result({}), git, enabled: () => true },
    );
    expect(quiet.payload).toEqual({});

    const warned = await handleHookRegressionRequest(
      operator,
      {},
      {
        run: async () => result({ diffHash: 'hash-2', status: 'no-tests', testsRun: [], untestedFiles: ['src/d.ts'] }),
        git,
        enabled: () => true,
      },
    );
    expect(warned.payload.decision).toBeUndefined();
    expect(String(warned.payload.systemMessage)).toContain('área tocada sem teste — src/d.ts');
  });

  it('missão, helper não-operador, read-only e flag desligada não rodam o portão', async () => {
    const run = vi.fn(async () => failed);
    const deps = { run, git, enabled: () => true };
    await handleHookRegressionRequest({ ...operator, missionId: 'm-1' }, {}, deps);
    await handleHookRegressionRequest({ ...operator, role: 'worker' }, {}, deps);
    await handleHookRegressionRequest({ ...operator, readOnly: true }, {}, deps);
    await handleHookRegressionRequest(operator, {}, { ...deps, enabled: () => false });
    expect(run).not.toHaveBeenCalled();
  });

  it('operador promovido a orquestrador (missão sob demanda do 1º helper) continua com o portão no Stop', async () => {
    const run = vi.fn(async () => failed);
    const deps = { run, git, enabled: () => true };
    const minted = mintToken({ label: 'operador', role: 'user', scope });
    bindTokenToSession(minted.token, 'op-promovido');
    expect(adoptUserSessionAsMissionOrchestrator('op-promovido', 'm-sob-demanda')).toBe(true);
    const promoted = getContextBySession('op-promovido')!;
    expect(promoted).toMatchObject({ role: 'orchestrator', missionId: 'm-sob-demanda' });

    const response = await handleHookRegressionRequest(promoted, {}, deps);

    expect(run).toHaveBeenCalledTimes(1);
    expect(response.payload).toMatchObject({ decision: 'block' });
    // Maestro que não veio da mão do operador segue fora (o dele é o handoff).
    await handleHookRegressionRequest({ ...operator, role: 'orchestrator', missionId: 'm-1' }, {}, deps);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('base da sessão: HEAD no spawn (reflog); sem spawn conhecido, o primeiro HEAD visto', async () => {
    const run = vi.fn(async (_input: { baseSha?: string; startedAtMs?: number }) =>
      result({ status: 'clean', changedFiles: [] }),
    );
    await handleHookRegressionRequest(operator, {}, { run: run as never, git, enabled: () => true, startedAtMs: () => 1_000 });
    expect(run.mock.calls[0]![0]).toMatchObject({ startedAtMs: 1_000, baseSha: undefined });

    const heads = ['a'.repeat(40), 'b'.repeat(40)];
    const movingGit = {
      run: () => ({ status: 0, stdout: `${heads.shift()}\n`, stderr: '' }),
    } as unknown as GitRunner;
    const deps = { run: run as never, git: movingGit, enabled: () => true, startedAtMs: () => null };
    const other = { ...operator, sessionId: 'op-2' };
    await handleHookRegressionRequest(other, {}, deps);
    await handleHookRegressionRequest(other, {}, deps);
    // A base não anda com o HEAD: commits de turnos anteriores continuam no diff.
    expect(run.mock.calls[1]![0]).toMatchObject({ baseSha: 'a'.repeat(40) });
    expect(run.mock.calls[2]![0]).toMatchObject({ baseSha: 'a'.repeat(40) });
  });

  it('árvore limpa zera os bloqueios consecutivos', async () => {
    let n = 0;
    const run = vi.fn(async () => ({ ...failed, diffHash: `hash-${(n += 1)}` }));
    const clean = vi.fn(async () => result({ status: 'clean', changedFiles: [] }));
    const decisions: unknown[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_STOP_BLOCKS + 1; i += 1) {
      decisions.push((await handleHookRegressionRequest(operator, {}, { run, git, enabled: () => true })).payload.decision);
      await handleHookRegressionRequest(operator, {}, { run: clean, git, enabled: () => true });
    }
    expect(decisions).toEqual(Array.from({ length: MAX_CONSECUTIVE_STOP_BLOCKS + 1 }, () => 'block'));
  });

  it('transporte que desistiu não gasta o relato: o próximo Stop do mesmo diff ainda bloqueia', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort(); // curl estourou o --max-time enquanto os testes rodavam
      return failed;
    });
    const lost = await handleHookRegressionRequest(operator, {}, { run, git, enabled: () => true, signal: controller.signal });
    expect(lost.payload).toEqual({});

    const next = await handleHookRegressionRequest(operator, {}, { run: async () => failed, git, enabled: () => true });
    expect(next.payload).toMatchObject({ decision: 'block' });
  });

  it('orçamento do Stop cabe no transporte do hook, com folga para git e resposta', async () => {
    const run = vi.fn(async (_input: { timeoutMs?: number }) => result({ status: 'clean', changedFiles: [] }));
    await handleHookRegressionRequest(operator, {}, { run: run as never, git, enabled: () => true });
    const budget = run.mock.calls[0]![0].timeoutMs!;
    expect(budget).toBe(STOP_HOOK_BUDGET_MS);
    expect(budget + 20_000).toBeLessThanOrEqual(REGRESSION_HOOK_TRANSPORT_SECONDS * 1000);
    expect(REGRESSION_HOOK_TRANSPORT_SECONDS).toBeLessThan(REGRESSION_HOOK_TIMEOUT_SECONDS);
  });

  it('helper do "+ Pane" (tem pai operador) não passa pelo portão de novo no Stop', async () => {
    const run = vi.fn(async () => failed);
    await handleHookRegressionRequest({ ...operator, operatorParentSessionId: 'op-pai' }, {}, { run, git, enabled: () => true });
    expect(run).not.toHaveBeenCalled();
  });

  it('erro no portão responde {} (o hook nunca atrapalha o CLI)', async () => {
    const response = await handleHookRegressionRequest(
      operator,
      {},
      {
        run: async () => {
          throw new Error('boom');
        },
        git,
        enabled: () => true,
      },
    );
    expect(response).toEqual({ statusCode: 200, payload: {} });
  });
});
