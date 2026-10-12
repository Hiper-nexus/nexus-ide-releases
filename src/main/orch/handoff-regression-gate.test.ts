// F-1283: o writer retomado de um CLI sem PostToolUse (agy, devin, muse,
// minimax-code, opencode, mimo-code) não tem proveniência; o que o protege no
// handoff é o próprio `filesModified`. O portão real roda sobre git real; só o
// runner, a base do writer isolado e o spawn da sessão são dublês.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetRegressionGateForTests, type RegressionExec } from '../regression-gate/regression-gate';
import { __resetRegressionHandoffBouncesForTests } from '../regression-gate/regression-gate-handoff';
import { ProcessGitRunner } from '../runtime/git-command';
import { testProjectScope } from './__tests__/scope-fixture';
import { evaluateWriterHandoffRegression } from './handoff-regression-gate';

const fixture = vi.hoisted(() => ({
  spawnedAt: new Map<string, number>(),
  exec: undefined as RegressionExec | undefined,
}));

vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  getSessionSpawnedAtMs: (sessionId: string) => fixture.spawnedAt.get(sessionId) ?? null,
  // CLI sem PostToolUse: nenhuma conversa com edição registrada.
  getSessionProviderConversation: () => null,
}));
vi.mock('./isolated-writer-worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./isolated-writer-worktree')>()),
  isolatedWriterBaseShaOfSession: () => undefined,
}));
vi.mock('../regression-gate/regression-gate-handoff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../regression-gate/regression-gate-handoff')>();
  return {
    ...actual,
    evaluateHandoffRegressionGate: (
      input: Parameters<typeof actual.evaluateHandoffRegressionGate>[0],
      deps: Parameters<typeof actual.evaluateHandoffRegressionGate>[1] = {},
    ) => actual.evaluateHandoffRegressionGate(input, { ...deps, exec: fixture.exec, enabled: () => true }),
  };
});

const HOUR = 3_600_000;
const roots: string[] = [];

afterEach(() => {
  __resetRegressionGateForTests();
  __resetRegressionHandoffBouncesForTests();
  fixture.spawnedAt.clear();
  fixture.exec = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** Vermelho só no checkout do writer; verde na worktree da base (F-246): a quebra é do diff. */
function failingOnlyAt(root: string, failing: readonly string[]) {
  return vi.fn<RegressionExec>(async (_file, args, options) => {
    const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    const files = args.filter((arg) => arg.endsWith('.test.ts'));
    const red = (file: string) => options.cwd === root && failing.includes(file);
    fs.writeFileSync(outFile, JSON.stringify({
      testResults: files.map((file) => ({
        name: path.join(options.cwd, file),
        status: red(file) ? 'failed' : 'passed',
        assertionResults: [red(file)
          ? { status: 'failed', fullName: 'c', failureMessages: ['vermelho'] }
          : { status: 'passed', fullName: 'ok' }],
      })),
    }));
    return { exitCode: files.some(red) ? 1 : 0, timedOut: false, stdout: '', stderr: '' };
  });
}

/**
 * A 1ª encarnação do writer deixou `src/c.ts` sujo e vermelho ontem; a
 * retomada exata (spawn novo, mesma conversa) entrega o handoff agora.
 */
function resumedWriter(sessionId: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1283-')));
  roots.push(root);
  const git = new ProcessGitRunner();
  write(root, 'src/c.ts', 'export const c = 3;\n');
  write(root, 'src/c.test.ts', "import { c } from './c';\n");
  write(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
  write(root, 'node_modules/.bin/vitest', '#!/bin/sh\n');
  write(root, '.gitignore', 'node_modules\n');
  git.run(root, ['init', '-q']);
  git.run(root, ['add', '-A']);
  git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  write(root, 'src/c.ts', 'export const c = 30;\n');
  const editedAtMs = Date.now() - 20 * HOUR;
  fs.utimesSync(path.join(root, 'src/c.ts'), new Date(editedAtMs), new Date(editedAtMs));
  fixture.spawnedAt.set(sessionId, Date.now() - 1_000);
  fixture.exec = failingOnlyAt(root, ['src/c.test.ts']);
  const scope = testProjectScope({ rootRealPath: root });
  return { root, ctx: { sessionId, scope, executionScope: scope } };
}

describe('F-1283: handoff do writer retomado sem proveniência responde pelo que declara', () => {
  it('arquivo declarado com caminho ABSOLUTO dentro da raiz conta como do writer e devolve o handoff', async () => {
    const { root, ctx } = resumedWriter('writer-abs');

    const verdict = await evaluateWriterHandoffRegression(ctx, { declaredFiles: [path.join(root, 'src/c.ts')] });

    expect(verdict.kind).toBe('retry');
    expect(verdict.kind === 'retry' && verdict.message).toContain('src/c.test.ts');
  });

  it('controle: declarado com caminho relativo já devolvia o handoff', async () => {
    const { ctx } = resumedWriter('writer-rel');

    const verdict = await evaluateWriterHandoffRegression(ctx, { declaredFiles: ['src/c.ts'] });

    expect(verdict.kind).toBe('retry');
  });

  it('sem declaração (nem proveniência) segue herdado: o portão não culpa o WIP anterior ao spawn (F-1224)', async () => {
    const { ctx } = resumedWriter('writer-none');

    const verdict = await evaluateWriterHandoffRegression(ctx, { declaredFiles: [] });

    expect(verdict.kind).toBe('accepted');
    expect(verdict.kind === 'accepted' && verdict.artifact?.payload.inheritedFailures.map((failure) => failure.file))
      .toEqual(['src/c.test.ts']);
  });

  it('caminho absoluto fora da raiz de execução não entra no diff', async () => {
    const { root, ctx } = resumedWriter('writer-outside');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1283-fora-')));
    roots.push(outside);
    write(outside, 'src/c.ts', 'export const c = 30;\n');

    const verdict = await evaluateWriterHandoffRegression(ctx, {
      declaredFiles: [path.join(outside, 'src/c.ts'), path.join(root, '..', path.basename(outside), 'src/c.ts')],
    });

    expect(verdict.kind).toBe('accepted');
    expect(verdict.kind === 'accepted' && verdict.artifact?.payload.inheritedFailures.map((failure) => failure.file))
      .toEqual(['src/c.test.ts']);
  });
});
