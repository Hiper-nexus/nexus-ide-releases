import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { createHash } from 'node:crypto';
import { ProcessGitRunner } from '../runtime/git-command';
import { createContextAttestation, writeContextAttestation } from '../context/context-attestation';
import { BUSINESS_MODEL_EXTRACTOR } from '../context/business-model/business-model-bootstrap';
import {
  configureBusinessModelAttestedStore,
  recordAttestedBusinessModelHash,
} from '../context/business-model/business-model-attested-store';
import { BUSINESS_MODEL_TARGET_PATH } from '../context/business-model/business-model-contract';
import { computeBlastRadius } from '../context/orientation/orientation-blast-radius';
import type { ProjectOrientationMap } from '../context/orientation/orientation-types';
import {
  __resetRegressionGateForTests,
  detectRegressionRunner,
  formatRegressionGateReport,
  hashRegressionFile,
  RECORDED_EDIT_MAX_HASH_BYTES,
  runRegressionGate,
  type RegressionExec,
} from './regression-gate';
import {
  __resetRegressionHandoffBouncesForTests,
  evaluateHandoffRegressionGate,
  HANDOFF_REGRESSION_BUDGET_MS,
  REGRESSION_GATE_BOUNCES_PER_SESSION,
} from './regression-gate-handoff';

const roots: string[] = [];

afterEach(() => {
  __resetRegressionGateForTests();
  __resetRegressionHandoffBouncesForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** Repo: a ← b (b importa a), testes de a e de b, e c isolado com seu teste. */
function project(options: { runner?: 'vitest' | 'none' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-regression-')));
  roots.push(root);
  const git = new ProcessGitRunner();
  const run = (...args: string[]) => git.run(root, args).stdout.trim();
  run('init', '-q');
  run('config', 'user.name', 'Nexus Test');
  run('config', 'user.email', 'test@example.invalid');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, 'src/a.test.ts', "import { a } from './a';\n");
  write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n");
  write(root, 'src/b.test.ts', "import { b } from './b';\n");
  write(root, 'src/c.ts', 'export const c = 3;\n');
  write(root, 'src/c.test.ts', "import { c } from './c';\n");
  if (options.runner !== 'none') {
    write(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
    write(root, 'node_modules/.bin/vitest', '#!/bin/sh\n');
    write(root, '.gitignore', 'node_modules\n');
  }
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  return { root, scope };
}

/** Simula o `vitest run --reporter=json --outputFile=…`: falha os arquivos pedidos. */
function fakeVitest(failing: readonly string[] = []) {
  const calls: string[][] = [];
  const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
    calls.push([...args]);
    const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    const files = args.filter((arg) => arg.endsWith('.test.ts'));
    fs.writeFileSync(
      outFile,
      JSON.stringify({
        testResults: files.map((file) => ({
          name: path.join(options.cwd, file),
          status: failing.includes(file) ? 'failed' : 'passed',
          assertionResults: failing.includes(file)
            ? [{ status: 'failed', fullName: 'soma', failureMessages: ['expected 2 to be 3'] }]
            : [{ status: 'passed', fullName: 'ok' }],
        })),
      }),
    );
    return { exitCode: failing.length > 0 ? 1 : 0, timedOut: false, stdout: '', stderr: '' };
  });
  return { exec, calls };
}

const JEST_SCRIPTS = {
  test: 'jest --config tests/jest.config.js',
  'test:api':
    'node scripts/run-optional-suite.js tests/jest.config.js -- jest --config tests/jest.config.js --testPathPattern=tests/api',
  'test:db': 'jest --config tests/jest.config.js --runTestsByPath tests/db/x.test.ts --runInBand',
};

/** Repo com jest cuja config mora nos scripts (estilo saasbarbearia), não na raiz. */
function jestProject(scripts: Record<string, string> = JEST_SCRIPTS, spaced = false) {
  const parent = spaced
    ? (() => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-regression-root-')));
        roots.push(base);
        const dir = path.join(base, 'Application Support');
        fs.mkdirSync(dir);
        return dir;
      })()
    : os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'nexus-regression-jest-')));
  roots.push(root);
  const git = new ProcessGitRunner();
  const run = (...args: string[]) => git.run(root, args).stdout.trim();
  run('init', '-q');
  run('config', 'user.name', 'Nexus Test');
  run('config', 'user.email', 'test@example.invalid');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, 'src/a.test.ts', "import { a } from './a';\n");
  write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n");
  write(root, 'src/b.test.ts', "import { b } from './b';\n");
  write(root, 'tests/jest.config.js', 'module.exports = {};\n');
  write(root, 'package.json', JSON.stringify({ devDependencies: { jest: '*' }, scripts }));
  write(root, 'node_modules/.bin/jest', '#!/bin/sh\n');
  write(root, '.gitignore', 'node_modules\n');
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  return { root, scope };
}

/** Simula `jest --json --outputFile=…`: grava o relatório que a fábrica devolve. */
function fakeJest(report: (files: readonly string[], cwd: string) => Array<Record<string, unknown>>) {
  const calls: string[][] = [];
  const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
    calls.push([...args]);
    const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    const files = args.filter((arg) => arg.endsWith('.test.ts'));
    const results = report(files, options.cwd);
    fs.writeFileSync(outFile, JSON.stringify({ testResults: results }));
    return {
      exitCode: results.some((entry) => entry.status === 'failed') ? 1 : 0,
      timedOut: false,
      stdout: '',
      stderr: '',
    };
  });
  return { exec, calls };
}

function jestSuitePassed(files: readonly string[], cwd: string): Array<Record<string, unknown>> {
  return files.map((file) => ({
    name: path.join(cwd, file),
    status: 'passed',
    assertionResults: [{ status: 'passed', fullName: 'ok' }],
  }));
}

/** Relatório de suíte que NÃO CARREGOU (ts-jest ausente): nenhuma asserção executada. */
function jestSuiteLoadFailed(offender: (file: string, cwd: string) => string) {
  return (files: readonly string[], cwd: string): Array<Record<string, unknown>> =>
    files.map((file) => ({
      name: path.join(cwd, file),
      status: 'failed',
      message:
        `Test suite failed to run\n\n    SyntaxError: ${offender(file, cwd)}: Unexpected token (1:5)`,
      assertionResults: [],
    }));
}

describe('runRegressionGate', () => {
  it('roda o teste do módulo tocado e o de quem depende dele — e só esses', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest();

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('passed');
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect([...result.testsRun].sort()).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('src/c.test.ts');
  });

  it('teste impactado que falha vira status failed com o arquivo e a mensagem', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/b.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      { file: 'src/b.test.ts', message: 'soma: expected 2 to be 3' },
    ]);
    expect(formatRegressionGateReport(result)).toContain('Seu diff quebrou 1');
  });

  it('execução parcial (um passou, outro impactado não rodou) não vira passed nem entra no cache', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    // Runner que só executa a.test.ts (b.test.ts excluído pela config/prazo).
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      fs.writeFileSync(outFile, JSON.stringify({
        testResults: [{
          name: path.join(options.cwd, 'src/a.test.ts'),
          status: 'passed',
          assertionResults: [{ status: 'passed', fullName: 'ok' }],
        }],
      }));
      return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
    });

    const first = await runRegressionGate({ scope }, { exec });
    const second = await runRegressionGate({ scope }, { exec });

    expect(first.status).toBe('unavailable');
    expect(first.testsRun).toEqual(['src/a.test.ts']);
    expect(first.testsNotRun).toEqual(['src/b.test.ts']);
    expect(first.warnings.join('\n')).toContain('execução parcial');
    // F-1348: o runner rodou de fato (a.test.ts) e terminou sem b.test.ts: config, não prazo.
    expect(first.runner).toBe('vitest');
    expect(first.notRun?.causes).toEqual(['runner']);
    expect(second.cached).toBe(false);
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('pytest ausente (python3 sai 1 sem resumo do pytest) é NÃO verificado, nunca teste falhando', async () => {
    const { root, scope } = project();
    write(root, 'pytest.ini', '[pytest]\n');
    write(root, 'calc.py', 'def soma(a, b):\n    return a + b\n');
    write(root, 'test_calc.py', 'from calc import soma\n');
    fs.rmSync(path.join(root, 'package.json'));
    const exec = vi.fn<RegressionExec>(async () => ({
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: '/usr/bin/python3: No module named pytest',
    }));

    const result = await runRegressionGate({ scope }, { exec });

    expect(exec).toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
    expect(result.failures).toEqual([]);
    expect(result.testsNotRun).toContain('test_calc.py');
  });

  it('pytest com teste que falhou (resumo "1 failed") continua failed', async () => {
    const { root, scope } = project();
    write(root, 'pytest.ini', '[pytest]\n');
    write(root, 'calc.py', 'def soma(a, b):\n    return a - b\n');
    write(root, 'test_calc.py', 'from calc import soma\n');
    fs.rmSync(path.join(root, 'package.json'));
    const exec = vi.fn<RegressionExec>(async () => ({
      exitCode: 1,
      timedOut: false,
      stdout: 'FAILED test_calc.py::test_soma - assert -1 == 3\n1 failed in 0.01s\n',
      stderr: '',
    }));

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['test_calc.py']);
  });

  it('impactado cortado pelo teto de arquivos conta como não verificado, nunca como aprovado', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest();

    const result = await runRegressionGate({ scope, maxTestFiles: 1 }, { exec });

    expect(calls[0]!.filter((arg) => arg.endsWith('.test.ts'))).toHaveLength(1);
    expect(result.status).toBe('unavailable');
    expect(result.testsRun).toHaveLength(1);
    expect(result.testsNotRun).toHaveLength(1);
    expect(result.notRun?.causes).toEqual(['limit']);
  });

  it('F-1348: mapa de impacto que consome o prazo — o recibo não afirma runner e diz que foi o prazo do mapa', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    let clock = 0;
    const { exec } = fakeVitest();
    // A fase de impacto (raio do code map + grafo de imports) leva 43 dos 45 s.
    const blastRadius = () => {
      clock += 43_000;
      return null;
    };

    const result = await runRegressionGate(
      { scope, timeoutMs: 45_000 },
      { exec, now: () => clock, extensions: { blastRadius } },
    );

    expect(exec).not.toHaveBeenCalled();
    expect(result.status).toBe('unavailable');
    expect(result.testsRun).toEqual([]);
    expect(result.testsNotRun).toHaveLength(2);
    // Nenhum runner executou nada: o recibo não pode culpar (nem creditar) o vitest.
    expect(result.runner).toBeNull();
    expect(result.notRun).toEqual({ causes: ['map-deadline'], mapMs: 43_000, testBudgetMs: 2_000 });
  });

  it('F-1348: runner que sobe e estoura o prazo (recibo do F-1302) — sem runner, causa prazo dos testes', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    let clock = 0;
    // Mesma forma da resposta de execOwnedCheck ao vencer o prazo.
    const exec = vi.fn<RegressionExec>(async (_file, _args, options) => {
      clock += options.timeoutMs;
      return {
        exitCode: null,
        timedOut: true,
        retryable: true,
        stdout: '',
        stderr: '\nVerificação excedeu o prazo; aguardando encerramento físico antes de liberar recursos.',
      };
    });

    const result = await runRegressionGate({ scope, timeoutMs: 45_000 }, { exec, now: () => clock });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unavailable');
    expect(result.testsRun).toEqual([]);
    expect(result.runner).toBeNull();
    expect(result.notRun).toEqual({ causes: ['test-deadline'], mapMs: 0, testBudgetMs: 45_000 });
  });

  it('falha de arquivo que o portão não pediu (filtro por substring do vitest) não bloqueia', async () => {
    const { root, scope } = project();
    write(root, 'src/c.ts', 'export const c = 4;\n');
    const exec = vi.fn<RegressionExec>(async (_file, args, options) => {
      const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      fs.writeFileSync(outFile, JSON.stringify({
        testResults: [
          { name: path.join(options.cwd, 'src/c.test.ts'), status: 'passed', assertionResults: [{ status: 'passed' }] },
          {
            name: path.join(options.cwd, 'lib/src/c.test.ts'),
            status: 'failed',
            assertionResults: [{ status: 'failed', fullName: 'alheio', failureMessages: ['quebrado antes'] }],
          },
        ],
      }));
      return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
    });

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
  });

  it('execução compartilhada cancelada por quem a iniciou não vira "não verificado" para o outro chamador', async () => {
    const { root, scope } = project();
    write(root, 'src/c.ts', 'export const c = 4;\n');
    const passing = fakeVitest();
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const exec = vi.fn<RegressionExec>(async (file, args, options) => {
      if (options.signal) {
        release();
        await new Promise((resolve) => options.signal!.addEventListener('abort', resolve, { once: true }));
        return { exitCode: null, timedOut: false, aborted: true, stdout: '', stderr: '' };
      }
      return passing.exec(file, args, options);
    });
    const controller = new AbortController();

    const first = runRegressionGate({ scope, signal: controller.signal }, { exec });
    await started;
    const second = runRegressionGate({ scope }, { exec });
    controller.abort();

    expect((await first).status).toBe('unavailable');
    expect((await second).status).toBe('passed');
  });

  it('teste instável que passa na 2ª tentativa não barra; falha que se repete barra', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const flaky = fakeVitest(['src/b.test.ts']);
    const stable = fakeVitest();
    let call = 0;
    const exec = vi.fn<RegressionExec>((...args) =>
      (call++ === 0 ? flaky.exec : stable.exec)(...args),
    );

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('passed');
    expect(exec).toHaveBeenCalledTimes(2);
    // A retentativa roda só o arquivo que falhou.
    expect(stable.calls[0]!.filter((arg) => arg.endsWith('.test.ts'))).toEqual(['src/b.test.ts']);
    expect(result.warnings.join(' ')).toContain('instável(is), passaram na 2ª tentativa: src/b.test.ts');
  });

  it('retentativa respeita o prazo total: nunca ganha um timeout novo inteiro', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    let clock = 0;
    const failing = fakeVitest(['src/b.test.ts']);
    const timeouts: number[] = [];
    const exec = vi.fn<RegressionExec>(async (file, args, options) => {
      timeouts.push(options.timeoutMs);
      clock += 100_000; // primeira execução falha depois de 100s
      return failing.exec(file, args, options);
    });

    const result = await runRegressionGate({ scope, timeoutMs: 120_000 }, { exec, now: () => clock });

    expect(timeouts[0]).toBeLessThanOrEqual(120_000);
    // O que sobra (20s) é o teto da retentativa — não outros 120s.
    for (const timeout of timeouts.slice(1)) expect(timeout).toBeLessThanOrEqual(20_000);
    expect(result.status).toBe('failed');
  });

  it('sem runner no projeto alvo: fail-open com aviso, sem executar nada', async () => {
    const { root, scope } = project({ runner: 'none' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/a.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('unavailable');
    expect(result.warnings.join(' ')).toContain('nenhum runner de teste detectado');
    expect(formatRegressionGateReport(result)).toContain('NÃO VERIFICADO');
    expect(exec).not.toHaveBeenCalled();
  });

  it('cache por hash do diff: o mesmo diff não roda de novo; diff novo roda', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest();

    const first = await runRegressionGate({ scope }, { exec });
    const second = await runRegressionGate({ scope }, { exec });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.diffHash).toBe(first.diffHash);
    expect(exec).toHaveBeenCalledTimes(1);

    write(root, 'src/a.ts', 'export const a = 3;\n');
    const third = await runRegressionGate({ scope }, { exec });
    expect(third.cached).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('área tocada sem teste gera aviso explícito, sem bloquear', async () => {
    const { root, scope } = project();
    write(root, 'src/d.ts', 'export const d = 4;\n');
    const { exec } = fakeVitest();

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('no-tests');
    expect(result.untestedFiles).toEqual(['src/d.ts']);
    expect(formatRegressionGateReport(result)).toContain('área tocada sem teste — src/d.ts');
    expect(exec).not.toHaveBeenCalled();
  });

  it('invariantes e blast radius estendido entram por contrato; extensão quebrada é fail-open', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest();

    const result = await runRegressionGate(
      { scope },
      {
        exec,
        extensions: {
          invariants: () => [
            { id: 'INV-1', regra: 'c nunca muda com a', arquivos: ['src/a.ts'], testes: ['src/c.test.ts'] },
          ],
          blastRadius: () => {
            throw new Error('mapa fora do ar');
          },
        },
      },
    );

    expect(result.status).toBe('passed');
    expect(result.invariantsTouched).toEqual([{ id: 'INV-1', regra: 'c nunca muda com a', violated: false }]);
    expect(calls[0]).toContain('src/c.test.ts');
    expect(result.warnings.join(' ')).toContain('blast radius estendido indisponível');
  });

  it('commit de outro writer invalida o cache mesmo com o mesmo arquivo sujo', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest();
    await runRegressionGate({ scope }, { exec });

    write(root, 'src/b.test.ts', "import { b } from './b';\n// mudou\n");
    const git = new ProcessGitRunner();
    git.run(root, ['add', 'src/b.test.ts']);
    git.run(root, ['-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-qm', 'outro writer']);
    const second = await runRegressionGate({ scope }, { exec });

    expect(second.cached).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(second.headSha).toMatch(/^[a-f0-9]{40}$/u);
  });

  it('npm ci sem mudar o diff invalida o cache (dependências fazem parte do estado)', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    write(root, 'node_modules/.package-lock.json', '{}');
    const { exec } = fakeVitest();
    await runRegressionGate({ scope }, { exec });
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(root, 'node_modules/.package-lock.json'), later, later);

    const second = await runRegressionGate({ scope }, { exec });

    expect(second.cached).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('edição concorrente durante os testes descarta o resultado e não entra no cache', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const inner = fakeVitest();
    let edits = 0;
    const exec = vi.fn<RegressionExec>(async (file, args, options) => {
      const out = await inner.exec(file, args, options);
      if (edits++ === 0) write(root, 'src/a.ts', 'export const a = 99;\n'); // outro writer
      return out;
    });

    const first = await runRegressionGate({ scope }, { exec });
    expect(first.status).toBe('unavailable');
    expect(first.warnings.join(' ')).toContain('o checkout mudou durante a verificação');

    const second = await runRegressionGate({ scope }, { exec });
    expect(second.cached).toBe(false);
    expect(second.status).toBe('passed');
  });

  it('trabalho commitado depois do spawn entra no diff mesmo com a árvore limpa', async () => {
    const { root, scope } = project();
    const startedAtMs = Date.now();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const git = new ProcessGitRunner();
    git.run(root, ['add', '-A']);
    git.run(root, ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'writer']);
    const { exec } = fakeVitest(['src/b.test.ts']);

    const result = await runRegressionGate({ scope, startedAtMs }, { exec });

    expect(result.baseSource).toBe('spawn');
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.status).toBe('failed');
  });

  it('WIP que já estava sujo antes do spawn não é cobrado de quem entrega', async () => {
    const { root, scope } = project();
    write(root, 'src/c.ts', 'export const c = 30;\n'); // WIP de outra pessoa
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, 'src/c.ts'), old, old);
    const startedAtMs = Date.now() - 1_000;
    write(root, 'src/a.ts', 'export const a = 2;\n'); // o delta de quem entrega
    const { exec } = fakeVitest(['src/c.test.ts']);

    const result = await runRegressionGate({ scope, startedAtMs }, { exec });

    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
    expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
    expect(result.warnings.join(' ')).toContain('WIP anterior ao seu spawn');
  });

  describe('F-1224: teste de WIP alheio puxado pelo code map (raio estendido)', () => {
    /** Code map mínimo: o raio de produção sempre contém as próprias sementes. */
    function codeMapExtension(adjacency: Record<string, string[]>) {
      const reverse: Record<string, string[]> = {};
      for (const [from, tos] of Object.entries(adjacency)) for (const to of tos) (reverse[to] ??= []).push(from);
      const map = {
        mapHash: 'map-test',
        inventory: { entrypoints: [] },
        symbols: { hubs: [] },
        graph: { edgeCount: 1, dbEdgeCount: 0, sampleEdges: [], dbEntities: [], adjacency, reverse },
      } as unknown as ProjectOrientationMap;
      return vi.fn(({ changedFiles }: { changedFiles: readonly string[] }) => ({
        tests: [...computeBlastRadius(map, { seedFiles: changedFiles, depth: 1 }).tests],
        dbEntities: [],
        dbConsumers: [],
      }));
    }

    /** Teste vermelho não rastreado de outro agente, sujo antes do spawn (o selo de 11/10). */
    function foreignRedWip(root: string): number {
      write(root, 'src/seal.ts', 'export const seal = 1;\n');
      write(root, 'src/seal.test.ts', "import { seal } from './seal';\n");
      const old = new Date(Date.now() - 60_000);
      for (const file of ['src/seal.ts', 'src/seal.test.ts']) fs.utimesSync(path.join(root, file), old, old);
      return Date.now() - 1_000;
    }

    it('pane sem delta próprio (o Stop de 11/10): a falha vira herdada, não devolução', async () => {
      const { root, scope } = project();
      const startedAtMs = foreignRedWip(root);
      const blastRadius = codeMapExtension({ 'src/seal.test.ts': ['src/seal.ts'] });
      const { exec } = fakeVitest(['src/seal.test.ts']);

      const result = await runRegressionGate({ scope, startedAtMs }, { exec, extensions: { blastRadius } });

      expect(blastRadius).toHaveBeenCalled();
      expect(result.status).not.toBe('failed');
      expect(result.failures).toEqual([]);
      expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/seal.test.ts']);
    });

    it('com delta próprio sem relação: idem — o raio do WIP não vira autoria de quem entrega', async () => {
      const { root, scope } = project();
      const startedAtMs = foreignRedWip(root);
      write(root, 'src/a.ts', 'export const a = 2;\n');
      const blastRadius = codeMapExtension({ 'src/seal.test.ts': ['src/seal.ts'], 'src/a.test.ts': ['src/a.ts'] });
      const { exec } = fakeVitest(['src/seal.test.ts']);

      const result = await runRegressionGate({ scope, startedAtMs }, { exec, extensions: { blastRadius } });

      expect(result.status).toBe('passed');
      expect(result.failures).toEqual([]);
      expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/seal.test.ts']);
    });

    it('teste que o code map puxa do delta próprio continua contando, mesmo com WIP alheio', async () => {
      const { root, scope } = project();
      const startedAtMs = foreignRedWip(root);
      write(root, 'src/c.ts', 'export const c = 30;\n'); // o delta de quem entrega
      // Só o code map liga b.test.ts a c.ts (o grafo de imports, não).
      const blastRadius = codeMapExtension({ 'src/seal.test.ts': ['src/seal.ts'], 'src/b.test.ts': ['src/c.ts'] });
      const inner = fakeVitest(['src/b.test.ts', 'src/seal.test.ts']);
      // Na worktree da base (F-246) o b passa: a quebra é do delta.
      const exec = vi.fn<RegressionExec>((file, args, options) =>
        options.cwd === root ? inner.exec(file, args, options) : fakeVitest().exec(file, args, options));

      const result = await runRegressionGate({ scope, startedAtMs }, { exec, extensions: { blastRadius } });

      expect(result.status).toBe('failed');
      expect(result.failures.map((failure) => failure.file)).toEqual(['src/b.test.ts']);
      expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/seal.test.ts']);
    });
  });

  describe('F-1237: autoria por proveniência (edições registradas da conversa retomada)', () => {
    const HOUR = 3_600_000;
    /** F-1242: o registro guarda o sha256 do conteúdo que a conversa deixou. */
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    function age(root: string, file: string, atMs: number): void {
      fs.utimesSync(path.join(root, file), new Date(atMs), new Date(atMs));
    }
    /** Falha só no checkout do pane; na worktree da base (F-246) passa: a quebra é do diff. */
    function failingOnlyAt(root: string, failing: readonly string[]) {
      const inner = fakeVitest(failing);
      return vi.fn<RegressionExec>((file, args, options) =>
        options.cwd === root ? inner.exec(file, args, options) : fakeVitest().exec(file, args, options));
    }

    it('(a) edição antiga que a própria conversa registrou, vermelha, bloqueia o pane retomado', async () => {
      const { root, scope } = project();
      const editedAtMs = Date.now() - 20 * HOUR; // 1ª encarnação, ontem
      write(root, 'src/c.ts', 'export const c = 30;\n');
      age(root, 'src/c.ts', editedAtMs - 50);
      const startedAtMs = Date.now() - 1_000; // retomada: spawn novo, mesma conversa
      const exec = failingOnlyAt(root, ['src/c.test.ts']);

      const before = await runRegressionGate({ scope, startedAtMs }, { exec });
      expect(before.status).not.toBe('failed'); // sem registro: o mtime diz "alheio"
      __resetRegressionGateForTests();
      const result = await runRegressionGate(
        { scope, startedAtMs, recordedEdits: new Map([['src/c.ts', sha256('export const c = 30;\n')]]) },
        { exec },
      );

      expect(result.status).toBe('failed');
      expect(result.failures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
      expect(result.inheritedFailures).toEqual([]);
    });

    it('(b) WIP de outro agente, não registrado e mais novo que o nascimento da conversa, continua herdado', async () => {
      const { root, scope } = project();
      const bornAtMs = Date.now() - 20 * HOUR;
      // A conversa editou c.ts ao nascer; o trabalho já foi integrado (limpo).
      const recordedEdits = new Map([['src/c.ts', sha256('export const c = 3;\n')]]);
      write(root, 'src/a.ts', 'export const a = 2;\n'); // WIP do outro agente, depois do nascimento
      age(root, 'src/a.ts', bornAtMs + 2 * HOUR);
      const startedAtMs = Date.now() - 1_000;
      const exec = failingOnlyAt(root, ['src/a.test.ts']);

      const result = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec });

      expect(result.status).not.toBe('failed');
      expect(result.failures).toEqual([]);
      expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/a.test.ts']);
      expect(result.changedFiles).toEqual(['src/a.ts']); // o registro limpo não alarga o diff
    });

    it('F-1242: reescrito depois (outro agente 1 s depois, ou formatador) volta a ser alheio; o mesmo conteúdo segue da conversa', async () => {
      const { root, scope } = project();
      const editedAtMs = Date.now() - 20 * HOUR;
      const recordedEdits = new Map([['src/c.ts', sha256('export const c = 30;\n')]]);
      write(root, 'src/c.ts', 'export const c = 31;\n');
      age(root, 'src/c.ts', editedAtMs + 1_000); // o outro agente escreveu por cima 1 s depois
      const startedAtMs = Date.now() - 1_000;
      const exec = failingOnlyAt(root, ['src/c.test.ts']);

      const rewritten = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec });
      expect(rewritten.status).not.toBe('failed');
      expect(rewritten.inheritedFailures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);

      __resetRegressionGateForTests();
      write(root, 'src/c.ts', 'export const c = 30;'); // formatador: mudou o conteúdo, fica alheio (fail-open)
      age(root, 'src/c.ts', editedAtMs);
      const formatted = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec });
      expect(formatted.status).not.toBe('failed');

      __resetRegressionGateForTests();
      write(root, 'src/c.ts', 'export const c = 30;\n'); // exatamente o que a conversa deixou
      age(root, 'src/c.ts', editedAtMs + 3 * HOUR); // o mtime não decide
      const same = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec });
      expect(same.status).toBe('failed');
      expect(same.failures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
    });

    it('F-1242: hash só de arquivo regular, sem seguir symlink, até o teto', async () => {
      const { root } = project();
      write(root, 'src/c.ts', 'export const c = 30;\n');
      fs.symlinkSync('c.ts', path.join(root, 'src/link.ts'));
      fs.writeFileSync(path.join(root, 'src/big.ts'), Buffer.alloc(RECORDED_EDIT_MAX_HASH_BYTES + 1, 0x61));
      fs.writeFileSync(path.join(root, 'src/limit.ts'), Buffer.alloc(RECORDED_EDIT_MAX_HASH_BYTES, 0x61));

      expect(await hashRegressionFile(root, 'src/c.ts')).toBe(sha256('export const c = 30;\n'));
      expect(await hashRegressionFile(root, 'src/limit.ts')).toBe(
        createHash('sha256').update(Buffer.alloc(RECORDED_EDIT_MAX_HASH_BYTES, 0x61)).digest('hex'),
      );
      expect(await hashRegressionFile(root, 'src/link.ts')).toBeNull();
      expect(await hashRegressionFile(root, 'src/big.ts')).toBeNull();
      expect(await hashRegressionFile(root, 'src')).toBeNull();
      expect(await hashRegressionFile(root, 'src/nao-existe.ts')).toBeNull();
    });
  });

  it('dois arquivos relacionados mudando juntos não viram "área sem teste"', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 2;\n");
    const { exec } = fakeVitest();

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.untestedFiles).toEqual([]);
  });

  it('módulo removido: os testes de quem ainda o importa entram no conjunto', async () => {
    const { root, scope } = project();
    fs.rmSync(path.join(root, 'src/a.ts'));
    fs.rmSync(path.join(root, 'src/a.test.ts'));
    const { exec, calls } = fakeVitest(['src/b.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.changedFiles).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(calls[0]).toContain('src/b.test.ts');
    expect(result.status).toBe('failed');
  });

  it('import por alias do tsconfig (`@/…`) também puxa o teste de quem importa', async () => {
    const { root, scope } = project();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/d.ts', "import { c } from '@/c';\nexport const d = c;\n");
    write(root, 'src/d.test.ts', "import { d } from './d';\n");
    const git = new ProcessGitRunner();
    git.run(root, ['add', '-A']);
    git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'alias']);
    write(root, 'src/c.ts', 'export const c = 4;\n');
    const { exec, calls } = fakeVitest();

    await runRegressionGate({ scope }, { exec });

    expect(calls[0]).toContain('src/d.test.ts');
  });

  it.each([false, true])('invariante do modelo atestado roda no checkout de execução (fallback=%s)', async (fallback) => {
    const { root, scope } = project();
    const doc = {
      schemaVersion: 1,
      flows: [],
      invariants: [
        {
          id: 'fechar_comanda#1',
          fluxo: 'fechar_comanda',
          regra: 'comanda fechada não recebe item',
          origem: 'supabase/migrations/001.sql:10',
          arquivos: ['src/a.ts'],
          tabelas: ['comandas'],
          funcoes: [],
          testes: ['src/c.test.ts'],
        },
      ],
    };
    const content = `# Modelo\n\n<!-- nexus:business-model:v1 -->\n\n\`\`\`json\n${JSON.stringify(doc)}\n\`\`\`\n`;
    write(root, BUSINESS_MODEL_TARGET_PATH, content);
    // Desde a rodada 3b o contrato só entrega invariantes de doc ATESTADO pelo
    // extrator (doc sem revisão não vira instrução nem entra no portão).
    writeContextAttestation(scope, createContextAttestation(scope, {
      targetPath: BUSINESS_MODEL_TARGET_PATH,
      targetHash: createHash('sha256').update(content).digest('hex'),
      sources: [{
        type: 'file',
        locator: 'src/a.ts',
        sourceHash: createHash('sha256').update(fs.readFileSync(path.join(root, 'src/a.ts'))).digest('hex'),
      }],
      author: BUSINESS_MODEL_EXTRACTOR,
      reviewer: { id: 'nexus-business-model-reviewer', sessionId: 'deterministic-rederive-v1', provider: 'nexus-mechanical-review' },
      reviewedAt: new Date(0).toISOString(),
      nexusVersion: 'test',
    }));
    // Quem autoriza é o registro do Main (fora do checkout), não a atestação do repo.
    configureBusinessModelAttestedStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bm-attested-')));
    recordAttestedBusinessModelHash(scope, createHash('sha256').update(content).digest('hex'));
    const git = new ProcessGitRunner();
    git.run(root, ['add', '-A']);
    git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'modelo']);
    const execution = fallback ? project() : { root, scope };
    write(execution.root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest(['src/c.test.ts']);

    const result = await runRegressionGate({ scope: execution.scope, projectScope: scope }, { exec });

    expect(calls[0]).toContain('src/c.test.ts');
    expect(result.status).toBe('failed');
    expect(result.invariantsTouched).toEqual([
      { id: 'fechar_comanda#1', regra: 'comanda fechada não recebe item', violated: true },
    ]);
    expect(formatRegressionGateReport(result)).toContain('Invariantes de negócio VIOLADOS');
    if (fallback) {
      const foreign = await runRegressionGate({ scope: execution.scope, projectScope: { ...scope, projectId: 'other' } }, { exec });
      expect(foreign.invariantsTouched).toEqual([]);
      expect(foreign.cached).toBe(false);
      fs.unlinkSync(path.join(root, BUSINESS_MODEL_TARGET_PATH));
      const withoutModel = await runRegressionGate({ scope: execution.scope, projectScope: scope }, { exec });
      expect(withoutModel.invariantsTouched).toEqual([]);
    }
  });

  it('invariante alcançado pela tabela do blast radius (dbEntities) também entra', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest();

    const result = await runRegressionGate(
      { scope },
      {
        exec,
        extensions: {
          blastRadius: () => ({ tests: [], dbEntities: ['public.comandas', 'comandas'] }),
          invariants: () => [{ id: 'INV-T', regra: 'total confere', tabelas: ['comandas'], testes: ['src/c.test.ts'] }],
        },
      },
    );

    expect(calls[0]).toContain('src/c.test.ts');
    expect(result.invariantsTouched.map((invariant) => invariant.id)).toEqual(['INV-T']);
  });

  it('git que falha ao listar o diff não passa por árvore limpa', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const real = new ProcessGitRunner();
    const git = {
      run: (cwd: string, args: readonly string[], options?: { allowFailure?: boolean }) =>
        args[0] === 'status'
          ? { status: 128, stdout: '', stderr: 'fatal: index.lock' }
          : real.run(cwd, args, options),
    } as unknown as ProcessGitRunner;
    const { exec } = fakeVitest();

    const result = await runRegressionGate({ scope }, { exec, git });

    expect(result.status).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('git não respondeu');
  });

  it('diff com mais de 256 arquivos: a regressão no arquivo 300 é selecionada e barra', async () => {
    const { root, scope } = project();
    for (let index = 0; index < 300; index += 1) {
      write(root, `src/aa/f${String(index).padStart(3, '0')}.ts`, `export const v${index} = ${index};\n`);
    }
    // O último em ordem: fora dos 256 primeiros.
    write(root, 'src/zz.ts', "import { c } from './c';\nexport const z = c;\n");
    write(root, 'src/zz.test.ts', "import { z } from './zz';\n");
    const { exec, calls } = fakeVitest(['src/zz.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.changedFiles.length).toBeGreaterThan(300);
    expect(calls.flat()).toContain('src/zz.test.ts');
    expect(result.status).toBe('failed');
  });

  it('diff acima do limite de robustez nunca aprova: NÃO verificado, preservando falhas', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const declaredFiles = Array.from({ length: 20_001 }, (_, index) => `zz/gone-${index}.md`);

    const passing = await runRegressionGate({ scope, declaredFiles }, { exec: fakeVitest().exec });
    expect(passing.status).toBe('unavailable');
    expect(passing.warnings.join('\n')).toContain('NÃO verificado');

    const failing = await runRegressionGate({ scope, declaredFiles }, { exec: fakeVitest(['src/b.test.ts']).exec });
    expect(failing.status).toBe('failed');
  }, 60_000);

  it('diff truncado que deixa só docs na seleção não vira "sem testes" aprovado: NÃO verificado', async () => {
    const { root, scope } = project();
    // Só docs no diff visível (nenhum teste selecionado) e um diff além do limite:
    // o retorno antecipado "sem testes" aprovaria um diff que o portão nem viu inteiro.
    const declaredFiles = Array.from({ length: 20_001 }, (_, index) => `aaa/gone-${index}.md`);
    write(root, 'docs/nota.md', '# nota\n');
    const { exec, calls } = fakeVitest();

    const result = await runRegressionGate({ scope, declaredFiles }, { exec });

    expect(calls).toHaveLength(0);
    expect(result.status).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('NÃO verificado');
  }, 60_000);

  it('pytest: test_a passou e test_b foi todo ignorado (relatório JUnit) — não é passed', async () => {
    const { root, scope } = project();
    write(root, 'pytest.ini', '[pytest]\n');
    write(root, 'test_a.py', 'def test_a():\n    assert True\n');
    write(root, 'test_b.py', 'import pytest\n@pytest.mark.skip\ndef test_b():\n    assert True\n');
    fs.rmSync(path.join(root, 'package.json'));
    const exec = vi.fn<RegressionExec>(async (_file, args) => {
      const junit = args.find((arg) => arg.startsWith('--junitxml='))!.slice('--junitxml='.length);
      fs.writeFileSync(
        junit,
        '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="2" skipped="1">' +
          '<testcase classname="test_a" name="test_a" file="test_a.py" line="0" time="0.001" />' +
          '<testcase classname="test_b" name="test_b" file="test_b.py" line="1" time="0.000">' +
          '<skipped type="pytest.skip" message="unconditional skip">test_b.py:1: unconditional skip</skipped></testcase>' +
          '</testsuite></testsuites>',
      );
      return { exitCode: 0, timedOut: false, stdout: '1 passed, 1 skipped in 0.01s\n', stderr: '' };
    });

    const result = await runRegressionGate({ scope }, { exec });

    expect(exec.mock.calls[0]![1]).toContain('junit_family=xunit1');
    expect(result.status).toBe('unavailable');
    expect(result.testsRun).toEqual(['test_a.py']);
    expect(result.testsNotRun).toEqual(['test_b.py']);
  });

  it('pytest: falha no relatório JUnit aponta o arquivo', async () => {
    const { root, scope } = project();
    write(root, 'pytest.ini', '[pytest]\n');
    write(root, 'test_a.py', 'def test_a():\n    assert False\n');
    fs.rmSync(path.join(root, 'package.json'));
    const exec = vi.fn<RegressionExec>(async (_file, args) => {
      const junit = args.find((arg) => arg.startsWith('--junitxml='))!.slice('--junitxml='.length);
      fs.writeFileSync(
        junit,
        '<testsuites><testsuite name="pytest"><testcase classname="test_a" name="test_a" file="test_a.py">' +
          '<failure message="assert False">trace</failure></testcase></testsuite></testsuites>',
      );
      return { exitCode: 1, timedOut: false, stdout: '1 failed\n', stderr: '' };
    });

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([{ file: 'test_a.py', message: 'test_a assert False' }]);
  });

  it('git que falha também no rev-parse HEAD (128) não vira árvore limpa', async () => {
    const { scope } = project();
    const git = {
      run: () => ({ status: 128, stdout: '', stderr: 'fatal: bad object HEAD' }),
    } as unknown as ProcessGitRunner;
    const { exec } = fakeVitest();

    const result = await runRegressionGate({ scope }, { exec, git });

    expect(result.status).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('git não respondeu');
  });

  it('repositório sem commits e sem arquivos continua limpo', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-regression-')));
    roots.push(root);
    new ProcessGitRunner().run(root, ['init', '-q']);
    const scope: ProjectExecutionScope = {
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: root,
      identitySource: 'manifest',
    };

    const result = await runRegressionGate({ scope }, { exec: fakeVitest().exec });

    expect(result.status).toBe('clean');
  });

  it('cancelamento compartilhado com dois consumidores dispara UMA substituta', async () => {
    const { root, scope } = project();
    write(root, 'src/c.ts', 'export const c = 4;\n');
    const passing = fakeVitest();
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let substitutes = 0;
    const exec = vi.fn<RegressionExec>(async (file, args, options) => {
      if (options.signal) {
        release();
        await new Promise((resolve) => options.signal!.addEventListener('abort', resolve, { once: true }));
        return { exitCode: null, timedOut: false, aborted: true, stdout: '', stderr: '' };
      }
      substitutes += 1;
      return passing.exec(file, args, options);
    });
    const controller = new AbortController();

    const first = runRegressionGate({ scope, signal: controller.signal }, { exec });
    await started;
    const second = runRegressionGate({ scope }, { exec });
    const third = runRegressionGate({ scope }, { exec });
    controller.abort();

    expect((await first).status).toBe('unavailable');
    expect((await second).status).toBe('passed');
    expect((await third).status).toBe('passed');
    expect(substitutes).toBe(1);
  });

  it('checkout limpo não roda nada', async () => {
    const { scope } = project();
    const { exec } = fakeVitest();
    const result = await runRegressionGate({ scope }, { exec });
    expect(result.status).toBe('clean');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('detectRegressionRunner — config do runner nos scripts (F-199)', () => {
  it('descobre tests/jest.config.js pelos scripts (estilo saasbarbearia)', () => {
    const { root } = jestProject();

    expect(detectRegressionRunner(root, root)).toMatchObject({
      kind: 'jest',
      config: 'tests/jest.config.js',
    });
  });

  it('não procura config quando a raiz tem jest.config.* ou o package.json tem chave jest', () => {
    const { root } = jestProject();
    write(root, 'jest.config.ts', 'export default {};\n');
    expect(detectRegressionRunner(root, root)!.config).toBeUndefined();
    fs.rmSync(path.join(root, 'jest.config.ts'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    pkg.jest = { testMatch: ['**/*.test.ts'] };
    write(root, 'package.json', JSON.stringify(pkg));
    expect(detectRegressionRunner(root, root)!.config).toBeUndefined();
  });

  it('aceita --config=caminho e -c caminho; ignora o --config de outro comando', () => {
    const { root } = jestProject({
      e2e: 'playwright test --config playwright.config.ts',
      unit: 'playwright test --config pw.ts && jest --config=tests/jest.config.js --runInBand',
      band: 'jest -c tests/jest.config.js',
    });
    write(root, 'playwright.config.ts', 'export {};\n');
    write(root, 'pw.ts', 'export {};\n');

    expect(detectRegressionRunner(root, root)!.config).toBe('tests/jest.config.js');
  });

  it('um --config solto de comando que não é jest não vira config do runner', () => {
    const { root } = jestProject({
      e2e: 'playwright test --config playwright.config.ts',
      test: 'jest --runInBand',
    });
    write(root, 'playwright.config.ts', 'export {};\n');

    expect(detectRegressionRunner(root, root)!.config).toBeUndefined();
  });

  it('rejeita ../ fora da raiz, caminho absoluto externo e arquivo inexistente', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gate-outside-')));
    roots.push(outside);
    write(outside, 'jest.config.js', 'module.exports = {};\n');
    const outsideFile = path.join(outside, 'jest.config.js');
    const { root } = jestProject({
      escaped: `jest --config ../${path.basename(outside)}/jest.config.js`,
      abs: `jest --config ${outsideFile}`,
      missing: 'jest --config tests/nope.config.js',
    });

    expect(detectRegressionRunner(root, root)!.config).toBeUndefined();
  });

  it('binário do jest por caminho (node_modules/.bin/jest) também habilita a leitura do --config', () => {
    const { root } = jestProject({
      test: 'node_modules/.bin/jest --config tests/jest.config.js',
    });

    expect(detectRegressionRunner(root, root)!.config).toBe('tests/jest.config.js');
  });

  it('escolhe a config usada pela maioria dos scripts', () => {
    const { root } = jestProject({
      a: 'jest --config other/jest.conf.js',
      b: 'jest --config tests/jest.config.js',
      c: 'jest --config tests/jest.config.js',
    });
    write(root, 'other/jest.conf.js', 'module.exports = {};\n');

    expect(detectRegressionRunner(root, root)!.config).toBe('tests/jest.config.js');
  });

  it('vitest: descobre --config nos scripts quando não há vite/vitest.config.*', () => {
    const { root } = project();
    write(root, 'vitest.unit.config.ts', 'export default {};\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    pkg.scripts = { test: 'vitest run --config vitest.unit.config.ts' };
    write(root, 'package.json', JSON.stringify(pkg));

    expect(detectRegressionRunner(root, root)).toMatchObject({ kind: 'vitest', config: 'vitest.unit.config.ts' });

    write(root, 'vitest.config.mts', 'export default {};\n');
    expect(detectRegressionRunner(root, root)!.config).toBeUndefined();
  });
});

describe('runTests com config descoberta (F-199)', () => {
  it('passa --config tests/jest.config.js na frente do --json para o jest', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeJest(jestSuitePassed);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('passed');
    const args = calls[0]!;
    const configIndex = args.indexOf('--config');
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(args[configIndex + 1]).toBe('tests/jest.config.js');
    expect(args.indexOf('--json')).toBeGreaterThan(configIndex);
  });
});

describe('falha de carga da suíte (F-199)', () => {
  it('SyntaxError fora do diff vira NÃO verificado com aviso por arquivo — nunca devolução', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(jestSuiteLoadFailed((file, cwd) => path.join(cwd, file)));

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('unavailable');
    expect(result.failures).toEqual([]);
    expect(result.testsRun).toEqual([]);
    expect([...result.testsNotRun].sort()).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    const warnings = result.warnings.join('\n');
    expect(warnings).toContain(
      'jest não conseguiu carregar src/a.test.ts (erro de parse fora do diff — configuração do runner do projeto?)',
    );
    expect(warnings).toContain('jest não conseguiu carregar src/b.test.ts');
    expect(formatRegressionGateReport(result)).toContain('NÃO VERIFICADO');
  });

  it('o arquivo quebrado estando no diff, a falha de carga segue devolução', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(jestSuiteLoadFailed((_file, cwd) => path.join(cwd, 'src/a.ts')));

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });

  it.each(['tests/jest.config.js', 'tsconfig.json', 'package.json'])(
    'config do runner/transform tocada pelo diff (%s) mantém a falha de carga como devolução',
    async (configFile) => {
      const { root, scope } = jestProject();
      write(root, 'src/a.ts', 'export const a = 2;\n');
      if (configFile === 'package.json') {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
        write(root, 'package.json', JSON.stringify({ ...pkg, private: true }));
      } else if (configFile === 'tsconfig.json') {
        write(root, 'tsconfig.json', '{}');
      } else {
        write(root, configFile, 'module.exports = { transform: {} };\n');
      }
      const { exec } = fakeJest(jestSuiteLoadFailed((file, cwd) => path.join(cwd, file)));

      const result = await runRegressionGate({ scope }, { exec });

      expect(result.changedFiles).toContain(configFile);
      expect(result.status).toBe('failed');
    },
  );

  it('ofensor com espaços no caminho que ESTÁ no diff segue devolução (worktree em "Application Support")', async () => {
    const { root, scope } = jestProject(JEST_SCRIPTS, true);
    expect(root).toContain(' ');
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(jestSuiteLoadFailed((_file, cwd) => path.join(cwd, 'src/a.ts')));

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });

  it('ofensor com espaços no caminho fora do diff continua não verificado', async () => {
    const { root, scope } = jestProject(JEST_SCRIPTS, true);
    expect(root).toContain(' ');
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(jestSuiteLoadFailed((file, cwd) => path.join(cwd, file)));

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('jest não conseguiu carregar src/a.test.ts');
  });

  it('ofensor do bloco Details: com espaços no caminho e no diff → devolução', async () => {
    const { root, scope } = jestProject(JEST_SCRIPTS, true);
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest((files, cwd) =>
      files.map((file) => ({
        name: path.join(cwd, file),
        status: 'failed',
        message:
          'Test suite failed to run\n\n    Jest encountered an unexpected token\n\n' +
          `    Details:\n\n    ${path.join(cwd, 'src/a.ts')}:3\n` +
          '    ({"Object.<anonymous>":function(module,exports,require){',
        assertionResults: [],
      })),
    );

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
  });

  it('falha de carga sem caminho na mensagem continua devolução (conservador)', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest((files, cwd) =>
      files.map((file) => ({
        name: path.join(cwd, file),
        status: 'failed',
        message: 'Test suite failed to run\n\n    SyntaxError: Unexpected token } in JSON at position 5',
        assertionResults: [],
      })),
    );

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
  });

  it('ofensor dentro de node_modules conta como fora do diff (nunca é dele)', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(
      jestSuiteLoadFailed((_file, cwd) => path.join(cwd, 'node_modules/foo/index.js')),
    );

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('unavailable');
    expect(result.warnings.join('\n')).toContain('jest não conseguiu carregar src/a.test.ts');
  });

  it('asserção falhando continua devolução mesmo com falha de carga alheia junto', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 2;\n");
    const { exec } = fakeJest((files, cwd) =>
      files.map((file) =>
        file === 'src/b.test.ts'
          ? {
              name: path.join(cwd, file),
              status: 'failed',
              assertionResults: [
                { status: 'failed', fullName: 'soma', failureMessages: ['expected 2 to be 3'] },
              ],
            }
          : {
              name: path.join(cwd, file),
              status: 'failed',
              message: `Test suite failed to run\n\n    SyntaxError: ${path.join(cwd, file)}: Unexpected token (1:5)`,
              assertionResults: [],
            },
      ),
    );

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([{ file: 'src/b.test.ts', message: 'soma: expected 2 to be 3' }]);
    expect(result.warnings.join('\n')).toContain('jest não conseguiu carregar src/a.test.ts');
  });
});

describe('evaluateHandoffRegressionGate', () => {
  it('falha bloqueia a aceitação: devolve ao agente e, esgotado, nunca vira success', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/a.test.ts']);
    const input = { sessionId: 'sess-1', scope };
    const deps = { exec, enabled: () => true };

    for (let i = 0; i < REGRESSION_GATE_BOUNCES_PER_SESSION; i += 1) {
      const verdict = await evaluateHandoffRegressionGate(input, deps);
      expect(verdict.kind).toBe('retry');
      if (verdict.kind === 'retry') {
        expect(verdict.message).toContain('handoff NÃO aceito');
        expect(verdict.message).toContain('src/a.test.ts');
      }
    }
    const exhausted = await evaluateHandoffRegressionGate(input, deps);
    expect(exhausted.kind).toBe('exhausted');
    // Cache: três avaliações do mesmo diff, uma execução (+ a retentativa da falha).
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('sem runner aceita (não bloqueia por infra) mas marca NÃO verificado; passou registra em artifact', async () => {
    const { root, scope } = project({ runner: 'none' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-2', scope },
      { enabled: () => true },
    );
    expect(verdict).toMatchObject({ kind: 'accepted', unverified: true });
    expect(verdict.kind === 'accepted' && verdict.artifact?.payload.status).toBe('unavailable');

    const withRunner = project();
    write(withRunner.root, 'src/a.ts', 'export const a = 2;\n');
    const passed = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-2', scope: withRunner.scope },
      { exec: fakeVitest().exec, enabled: () => true },
    );
    expect(passed.kind === 'accepted' && passed.artifact?.payload.status).toBe('passed');
  });

  it('falha de carga fora do diff NÃO bloqueia o handoff: aceito, marcado não verificado', async () => {
    const { root, scope } = jestProject();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeJest(jestSuiteLoadFailed((file, cwd) => path.join(cwd, file)));

    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-load', scope },
      { exec, enabled: () => true },
    );

    expect(verdict).toMatchObject({ kind: 'accepted', unverified: true });
    expect(verdict.kind === 'accepted' && verdict.artifact?.payload.status).toBe('unavailable');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('flag desligada pula o portão', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/a.test.ts']);
    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-3', scope },
      { exec, enabled: () => false },
    );
    expect(verdict).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('F-1288: portão lento corta no próprio orçamento, que cabe no prazo do cliente MCP (60 s)', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    let clock = 0;
    // Runner que estoura qualquer prazo que recebe — a "Verificação excedeu
    // o prazo… 0 rodaram, 10 não" do campo: cada execução consome o teto
    // que o gate lhe deu e devolve timedOut.
    const exec = vi.fn<RegressionExec>(async (_file, _args, options) => {
      clock += options.timeoutMs;
      return { exitCode: null, timedOut: true, aborted: false, stdout: '', stderr: '' };
    });
    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-f1288', scope },
      { exec, now: () => clock, enabled: () => true },
    );
    // Fail-open honesto: prazo vencido continua aceito e NÃO verificado.
    expect(verdict).toMatchObject({ kind: 'accepted', unverified: true });
    // O tempo que o submit passa DENTRO do portão respeita o orçamento do
    // handoff, e esse orçamento precisa deixar folga dos 60 s do cliente
    // MCP para o que ainda roda depois do gate (revisão Jev, persistência):
    // estourou o cliente, o agente reenvia e o Maestro recebe duas vezes.
    expect(clock).toBeLessThanOrEqual(HANDOFF_REGRESSION_BUDGET_MS);
    expect(HANDOFF_REGRESSION_BUDGET_MS).toBeLessThan(50_000);
  });

  it('F-1348: recibo do handoff sem execução não afirma runner e leva a causa fora do corte de avisos', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    let clock = 0;
    const exec = vi.fn<RegressionExec>(async (_file, _args, options) => {
      clock += options.timeoutMs;
      return { exitCode: null, timedOut: true, retryable: true, stdout: '', stderr: '' };
    });
    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-f1348', scope },
      { exec, now: () => clock, enabled: () => true },
    );

    expect(verdict).toMatchObject({ kind: 'accepted', unverified: true });
    const payload = verdict.kind === 'accepted' ? verdict.artifact?.payload : undefined;
    expect(payload?.testsRun).toEqual([]);
    expect(payload?.runner).toBeNull();
    expect(payload?.notRun).toEqual({ causes: ['test-deadline'], mapMs: 0, testBudgetMs: HANDOFF_REGRESSION_BUDGET_MS });
  });
});

describe('comparação com a base do diff (F-246)', () => {
  const baseSha = (root: string) =>
    new ProcessGitRunner().run(root, ['rev-parse', 'HEAD']).stdout.trim();
  const worktreeCount = (root: string) =>
    new ProcessGitRunner()
      .run(root, ['worktree', 'list', '--porcelain'])
      .stdout.split('\n')
      .filter((line) => line.startsWith('worktree ')).length;

  it('falha que reproduz na base sai para preexistingFailures e o veredito fica verde', async () => {
    const { root, scope } = project();
    const sha = baseSha(root);
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/b.test.ts']);

    const result = await runRegressionGate(
      { scope, baseSha: sha, trustedDependencyRoot: root },
      { exec },
    );

    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
    expect(result.preexistingFailures.map((failure) => failure.file)).toEqual(['src/b.test.ts']);
    expect(result.warnings.join(' ')).toContain(`falha pré-existente na base ${sha.slice(0, 7)}`);
    const report = formatRegressionGateReport(result);
    expect(report).toContain('não conta contra você');
    expect(report).toContain('src/b.test.ts');
    expect(worktreeCount(root)).toBe(1);
  });

  it('falha que NÃO reproduz na base continua regressão do diff', async () => {
    const { root, scope } = project();
    const sha = baseSha(root);
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const failing = fakeVitest(['src/b.test.ts']);
    const passing = fakeVitest();
    const exec = vi.fn<RegressionExec>((file, args, options) =>
      (options.cwd === root ? failing.exec : passing.exec)(file, args, options),
    );

    const result = await runRegressionGate(
      { scope, baseSha: sha, trustedDependencyRoot: root },
      { exec },
    );

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/b.test.ts']);
    expect(result.preexistingFailures).toEqual([]);
    expect(worktreeCount(root)).toBe(1);
  });

  it('arquivo de teste novo (ausente da base) segue contando como regressão', async () => {
    const { root, scope } = project();
    const sha = baseSha(root);
    write(root, 'src/d.ts', 'export const d = 4;\n');
    write(root, 'src/d.test.ts', "import { d } from './d';\n");
    const { exec } = fakeVitest(['src/d.test.ts']);

    const result = await runRegressionGate(
      { scope, baseSha: sha, trustedDependencyRoot: root },
      { exec },
    );

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toContain('src/d.test.ts');
    expect(result.preexistingFailures).toEqual([]);
  });

  it('sem base conhecida não compara — só avisa', async () => {
    const { root, scope } = project();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest(['src/b.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(result.status).toBe('failed');
    expect(result.preexistingFailures).toEqual([]);
    expect(result.warnings.join(' ')).toContain('comparação com a base não rodou');
    expect(worktreeCount(root)).toBe(1);
  });

  it('erro na execução da base ainda remove o worktree temporário', async () => {
    const { root, scope } = project();
    const sha = baseSha(root);
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const failing = fakeVitest(['src/b.test.ts']);
    const exec = vi.fn<RegressionExec>((file, args, options) => {
      if (options.cwd === root) return failing.exec(file, args, options);
      throw new Error('sandbox recusou a base');
    });

    const result = await runRegressionGate(
      { scope, baseSha: sha, trustedDependencyRoot: root },
      { exec },
    );

    expect(result.status).toBe('failed');
    expect(result.preexistingFailures).toEqual([]);
    expect(result.warnings.join(' ')).toContain('comparação com a base não rodou');
    expect(worktreeCount(root)).toBe(1);
  });
});

it('completion opt-in runs impacted E2E through the existing runner and cannot reuse the fast-gate cache', async () => {
  const { root, scope } = project();
  write(root, 'src/isolated.ts', 'export const isolated = 1;\n');
  write(root, 'e2e/isolated.test.ts', "import { isolated } from '../src/isolated';\n");
  const { exec } = fakeVitest();
  const fast = await runRegressionGate({ scope }, { exec });
  expect(fast.status).toBe('no-tests'); expect(exec).not.toHaveBeenCalled();
  expect(fast.coverage).toEqual({ indexComplete: true, skippedTests: ['e2e/isolated.test.ts'] });
  const completion = await runRegressionGate({ scope, includeE2E: true }, { exec });
  expect(completion.cached).toBe(false);
  expect(completion.status).toBe('passed'); expect(completion.testsRun).toContain('e2e/isolated.test.ts');
  expect(completion.coverage).toEqual({ indexComplete: true, skippedTests: [] });
});

it('completion reports incomplete graph coverage structurally and does not approve a truncated source index', async () => {
  const { root, scope } = project();
  write(root, 'src/a.ts', 'export const a = 2;\n' + ' '.repeat(600000));
  const { exec } = fakeVitest();
  const result = await runRegressionGate({ scope, includeE2E: true }, { exec });
  expect(result.coverage?.indexComplete).toBe(false);
  expect(result.status).toBe('unavailable');
});

it('completion cannot approve when the import traversal budget omitted known importers', async () => {
  const graph = await import('../context/orientation/orientation-import-graph');
  const original = graph.buildOrientationImportGraphFromFacts;
  const spy = vi.spyOn(graph, 'buildOrientationImportGraphFromFacts').mockImplementation((...args) => {
    const built = original(...args);
    return { ...built, reverse: new Map([['src/a.ts', [...Array.from({ length: 4000 }, (_, index) => `src/importer-${index}.ts`), 'src/b.test.ts']]]) };
  });
  try {
    const { root, scope } = project(); write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec } = fakeVitest();
    const result = await runRegressionGate({ scope, includeE2E: true }, { exec });
    expect(result.coverage?.indexComplete).toBe(false); expect(result.status).toBe('unavailable');
  } finally { spy.mockRestore(); }
});
