import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { createHash } from 'node:crypto';
import { ProcessGitRunner } from '../runtime/git-command';
import { createContextAttestation, writeContextAttestation } from '../context/context-attestation';
import { BUSINESS_MODEL_EXTRACTOR } from '../context/business-model/business-model-bootstrap';
import { BUSINESS_MODEL_TARGET_PATH } from '../context/business-model/business-model-contract';
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

  it('invariante do modelo de negócio (.context) tocado: seus testes rodam e a violação aparece', async () => {
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
    const git = new ProcessGitRunner();
    git.run(root, ['add', '-A']);
    git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'modelo']);
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const { exec, calls } = fakeVitest(['src/c.test.ts']);

    const result = await runRegressionGate({ scope }, { exec });

    expect(calls[0]).toContain('src/c.test.ts');
    expect(result.status).toBe('failed');
    expect(result.invariantsTouched).toEqual([
      { id: 'fechar_comanda#1', regra: 'comanda fechada não recebe item', violated: true },
    ]);
    expect(formatRegressionGateReport(result)).toContain('Invariantes de negócio VIOLADOS');
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
