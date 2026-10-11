import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBlastRadius } from '../context/orientation/orientation-blast-radius';
import type { ProjectOrientationMap } from '../context/orientation/orientation-types';
import {
  __resetRegressionGateForTests,
  runRegressionGate,
  type RegressionExec,
  type RegressionGateResult,
} from '../regression-gate/regression-gate';
import { ProcessGitRunner, type GitRunner } from '../runtime/git-command';
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
  handleHookRegressionHttp,
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
    version: 'regression-gate-v2',
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
    preexistingFailures: [],
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

const repos: string[] = [];

afterEach(() => {
  __resetHookRegressionForTests();
  __resetRegressionGateForTests();
  resetGateForTests();
  for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
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
    // F-1157: só a lane que o Hardened confina à leitura não escreve.
    await handleHookRegressionRequest({ ...operator, readOnly: true, readOnlyEnforced: true }, {}, deps);
    await handleHookRegressionRequest(operator, {}, { ...deps, enabled: () => false });
    expect(run).not.toHaveBeenCalled();
  });

  it('F-1157: o pane do operador só rotulado read-only escreve no Autopilot, então passa pelo portão', async () => {
    const run = vi.fn(async () => failed);
    await handleHookRegressionRequest({ ...operator, readOnly: true }, {}, { run, git, enabled: () => true });
    expect(run).toHaveBeenCalledOnce();
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

  it('Stop com corpo grande (resposta longa do agente) ainda passa pelo portão via HTTP', async () => {
    const run = vi.fn(async () => failed);
    const ctx = { ...operator, token: 't', label: 'op', allowedTools: null, allowedSkills: null,
      stopAttempts: 0, handoffSubmitted: false } as unknown as Parameters<typeof handleHookRegressionHttp>[2];
    const server = http.createServer((req, res) => {
      void handleHookRegressionHttp(req, res, ctx, { run, git, enabled: () => true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/hook/regression`, {
        method: 'POST',
        body: JSON.stringify({ last_assistant_message: 'x'.repeat(256 * 1024) }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ decision: 'block' });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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

  it('F-1224: Stop de pane sem delta próprio não bloqueia por teste vermelho de WIP alheio que o code map puxa', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stop-wip-')));
    repos.push(root);
    const sh = new ProcessGitRunner();
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    sh.run(root, ['init', '-q']);
    put('package.json', JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
    put('node_modules/.bin/vitest', '#!/bin/sh\n');
    put('.gitignore', 'node_modules\n');
    sh.run(root, ['add', '-A']);
    sh.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
    // WIP não rastreado de outro agente, vermelho e sujo antes do spawn do pane.
    put('src/seal.ts', 'export const seal = 1;\n');
    put('src/seal.test.ts', "import { seal } from './seal';\n");
    const old = new Date(Date.now() - 60_000);
    for (const file of ['src/seal.ts', 'src/seal.test.ts']) fs.utimesSync(path.join(root, file), old, old);
    const spawnedAtMs = Date.now() - 1_000;
    // Code map como em produção: o raio contém as próprias sementes.
    const map = {
      mapHash: 'm', inventory: { entrypoints: [] }, symbols: { hubs: [] },
      graph: { edgeCount: 1, dbEdgeCount: 0, sampleEdges: [], dbEntities: [],
        adjacency: { 'src/seal.test.ts': ['src/seal.ts'] }, reverse: { 'src/seal.ts': ['src/seal.test.ts'] } },
    } as unknown as ProjectOrientationMap;
    const blastRadius = ({ changedFiles }: { changedFiles: readonly string[] }) => ({
      tests: [...computeBlastRadius(map, { seedFiles: changedFiles, depth: 1 }).tests], dbEntities: [], dbConsumers: [],
    });
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      const files = args.filter((arg) => arg.endsWith('.test.ts'));
      fs.writeFileSync(outFile, JSON.stringify({ testResults: files.map((file) => ({
        name: path.join(options.cwd, file), status: 'failed',
        assertionResults: [{ status: 'failed', fullName: 'selo', failureMessages: ['vermelho'] }],
      })) }));
      return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
    });
    const pane = { role: 'user' as const, sessionId: 'op-seal', scope: testProjectScope({ rootRealPath: root }) };

    const response = await handleHookRegressionRequest(pane, {}, {
      run: (input) => runRegressionGate(input, { exec, extensions: { blastRadius } }),
      enabled: () => true,
      startedAtMs: () => spawnedAtMs,
    });

    expect(exec).toHaveBeenCalled();
    expect(response.payload.decision).toBeUndefined();
    expect(String(response.payload.systemMessage)).toContain('WIP anterior ao seu spawn');
  });

  it('F-1237: pane retomado bloqueia pela edição antiga que a própria conversa registrou; o WIP alheio segue herdado', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stop-f1237-')));
    repos.push(root);
    const sh = new ProcessGitRunner();
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    const age = (file: string, atMs: number) => fs.utimesSync(path.join(root, file), new Date(atMs), new Date(atMs));
    sh.run(root, ['init', '-q']);
    put('package.json', JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
    put('node_modules/.bin/vitest', '#!/bin/sh\n');
    put('.gitignore', 'node_modules\n');
    sh.run(root, ['add', '-A']);
    sh.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
    const bornAtMs = Date.now() - 20 * 3_600_000;
    // 1ª encarnação da conversa: escreveu x.ts e o teste dele (registrados pelo hook).
    put('src/x.ts', 'export const x = 1;\n');
    put('src/x.test.ts', "import { x } from './x';\n");
    for (const file of ['src/x.ts', 'src/x.test.ts']) age(file, bornAtMs + 60_000);
    // F-1242: o registro guarda o sha256 do conteúdo que a conversa deixou.
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const recorded = new Map([
      ['src/x.ts', sha256('export const x = 1;\n')],
      ['src/x.test.ts', sha256("import { x } from './x';\n")],
    ]);
    // Outro agente: WIP vermelho DEPOIS do nascimento da conversa, antes da retomada.
    put('src/seal.ts', 'export const seal = 1;\n');
    put('src/seal.test.ts', "import { seal } from './seal';\n");
    for (const file of ['src/seal.ts', 'src/seal.test.ts']) age(file, bornAtMs + 2 * 3_600_000);
    const spawnedAtMs = Date.now() - 1_000; // retomada: spawn novo
    const map = {
      mapHash: 'm', inventory: { entrypoints: [] }, symbols: { hubs: [] },
      graph: { edgeCount: 2, dbEdgeCount: 0, sampleEdges: [], dbEntities: [],
        adjacency: { 'src/x.test.ts': ['src/x.ts'], 'src/seal.test.ts': ['src/seal.ts'] },
        reverse: { 'src/x.ts': ['src/x.test.ts'], 'src/seal.ts': ['src/seal.test.ts'] } },
    } as unknown as ProjectOrientationMap;
    const blastRadius = ({ changedFiles }: { changedFiles: readonly string[] }) => ({
      tests: [...computeBlastRadius(map, { seedFiles: changedFiles, depth: 1 }).tests], dbEntities: [], dbConsumers: [],
    });
    // Vermelho só no checkout do pane; na worktree da base (F-246) passa.
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      const files = args.filter((arg) => arg.endsWith('.test.ts'));
      const red = options.cwd === root;
      fs.writeFileSync(outFile, JSON.stringify({ testResults: files.map((file) => ({
        name: path.join(options.cwd, file), status: red ? 'failed' : 'passed',
        assertionResults: [red
          ? { status: 'failed', fullName: 'vermelho', failureMessages: ['vermelho'] }
          : { status: 'passed', fullName: 'ok' }],
      })) }));
      return { exitCode: red ? 1 : 0, timedOut: false, stdout: '', stderr: '' };
    });
    const results: RegressionGateResult[] = [];
    const stop = (sessionId: string, recordedEdits?: ReadonlyMap<string, string>) =>
      handleHookRegressionRequest({ role: 'user', sessionId, scope: testProjectScope({ rootRealPath: root }) }, {}, {
        run: async (input) => {
          const gate = await runRegressionGate(input, { exec, extensions: { blastRadius } });
          results.push(gate);
          return gate;
        },
        enabled: () => true,
        startedAtMs: () => spawnedAtMs,
        recordedEdits: (_sessionId, rootRealPath) => (rootRealPath === root ? recordedEdits : undefined),
      });

    const resumed = await stop('op-resumed', recorded);
    expect(resumed.payload.decision).toBe('block');
    expect(results[0]!.failures.map((failure) => failure.file)).toEqual(['src/x.test.ts']);
    expect(results[0]!.inheritedFailures.map((failure) => failure.file)).toEqual(['src/seal.test.ts']);

    // Sem registro (CLI sem evento de edição, ou pane novo): como antes, tudo herdado.
    __resetRegressionGateForTests();
    const unrecorded = await stop('op-fresh');
    expect(unrecorded.payload.decision).toBeUndefined();
    expect(results[1]!.failures).toEqual([]);
    expect(String(unrecorded.payload.systemMessage)).toContain('WIP anterior ao seu spawn');
  });
});
