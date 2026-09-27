import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProcessGitRunner } from '../runtime/git-command';
import {
  __resetRegressionGateForTests,
  formatRegressionGateReport,
  runRegressionGate,
  type RegressionExec,
} from './regression-gate';
import {
  __resetRegressionHandoffBouncesForTests,
  evaluateHandoffRegressionGate,
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
    expect(result.invariantsTouched).toEqual([{ id: 'INV-1', regra: 'c nunca muda com a' }]);
    expect(calls[0]).toContain('src/c.test.ts');
    expect(result.warnings.join(' ')).toContain('blast radius estendido indisponível');
  });

  it('checkout limpo não roda nada', async () => {
    const { scope } = project();
    const { exec } = fakeVitest();
    const result = await runRegressionGate({ scope }, { exec });
    expect(result.status).toBe('clean');
    expect(exec).not.toHaveBeenCalled();
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

  it('sem runner aceita (fail-open) sem artifact; passou registra em artifact', async () => {
    const { root, scope } = project({ runner: 'none' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const verdict = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-2', scope },
      { enabled: () => true },
    );
    expect(verdict).toEqual({ kind: 'accepted' });

    const withRunner = project();
    write(withRunner.root, 'src/a.ts', 'export const a = 2;\n');
    const passed = await evaluateHandoffRegressionGate(
      { sessionId: 'sess-2', scope: withRunner.scope },
      { exec: fakeVitest().exec, enabled: () => true },
    );
    expect(passed.kind === 'accepted' && passed.artifact?.payload.status).toBe('passed');
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
});
