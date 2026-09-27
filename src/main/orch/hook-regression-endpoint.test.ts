import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegressionGateResult } from '../regression-gate/regression-gate';
import type { GitRunner } from '../runtime/git-command';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  __resetHookRegressionForTests,
  handleHookRegressionRequest,
  MAX_CONSECUTIVE_STOP_BLOCKS,
} from './hook-regression-endpoint';

const scope = testProjectScope();
const git: GitRunner = {
  run: () => ({ status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }),
} as unknown as GitRunner;

function result(partial: Partial<RegressionGateResult>): RegressionGateResult {
  return {
    version: 'regression-gate-v1',
    status: 'passed',
    diffHash: 'hash-1',
    changedFiles: ['src/a.ts'],
    testsRun: ['src/a.test.ts'],
    failures: [],
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

afterEach(() => __resetHookRegressionForTests());

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

  it('commits feitos depois do último Stop entram no diff (base = HEAD anterior)', async () => {
    const heads = ['a'.repeat(40), 'b'.repeat(40)];
    const movingGit = {
      run: () => ({ status: 0, stdout: `${heads.shift()}\n`, stderr: '' }),
    } as unknown as GitRunner;
    const run = vi.fn(async (_input: { baseSha?: string }) =>
      result({ status: 'clean', changedFiles: [] }),
    );
    await handleHookRegressionRequest(operator, {}, { run: run as never, git: movingGit, enabled: () => true });
    await handleHookRegressionRequest(operator, {}, { run: run as never, git: movingGit, enabled: () => true });
    expect(run.mock.calls[0]![0]).toMatchObject({ baseSha: undefined });
    expect(run.mock.calls[1]![0]).toMatchObject({ baseSha: 'a'.repeat(40) });
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
