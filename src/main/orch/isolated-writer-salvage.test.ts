import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const traceHarness = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../observability/main-trace', () => ({
  trace: (event: Record<string, unknown>) => {
    traceHarness.events.push(event);
  },
}));

import {
  salvageCoversWorktree,
  salvageIsolatedWriterWorktree,
  salvageNoticeSummary,
  salvageRefPrefix,
  scheduleWorktreeSalvage,
  setWorktreeSalvageNotifier,
  worktreeSalvageIdle,
  type WorktreeSalvageTarget,
} from './isolated-writer-salvage';
import { testProjectScope } from './__tests__/scope-fixture';
import { AsyncProcessGitRunner } from '../runtime/git-command';

const BRANCH = 'refs/heads/nexus/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb';
let temp: string;
let repo: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Teste',
      GIT_AUTHOR_EMAIL: 'teste@example.test',
      GIT_COMMITTER_NAME: 'Teste',
      GIT_COMMITTER_EMAIL: 'teste@example.test',
    },
  }).trim();
}

function target(overrides: Partial<WorktreeSalvageTarget> = {}): WorktreeSalvageTarget {
  return {
    worktreePath: worktree,
    branchRef: BRANCH,
    missionId: 'mission-a',
    taskId: 'pane-writer-a',
    reason: 'pane-exit',
    ...overrides,
  };
}

function salvageRefs(): string[] {
  const out = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nexus-salvage');
  return out ? out.split('\n') : [];
}

beforeEach(() => {
  traceHarness.events.length = 0;
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-salvage-')));
  repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', 'base.txt', '.gitignore');
  git(repo, 'commit', '-qm', 'base');
  worktree = path.join(temp, 'writer');
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH.slice('refs/heads/'.length), worktree);
});

afterEach(async () => {
  setWorktreeSalvageNotifier(null);
  await worktreeSalvageIdle();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('salvaguarda da worktree do writer isolado (F-794)', () => {
  it('worktree limpa não cria commit nem ref', async () => {
    await expect(salvageIsolatedWriterWorktree(target())).resolves.toEqual({ kind: 'clean' });
    expect(salvageRefs()).toEqual([]);
  });

  it('guarda alteração rastreada e arquivo novo sem tocar branch, índice, arquivos nem stash', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'trabalho validado\n');
    fs.writeFileSync(path.join(worktree, 'novo.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(worktree, 'ignored.log'), 'lixo de build\n');
    git(worktree, 'add', 'novo.ts');
    const headBefore = git(worktree, 'rev-parse', 'HEAD');
    const statusBefore = git(worktree, 'status', '--porcelain=v1');

    const result = await salvageIsolatedWriterWorktree(target({ handoffId: 'handoff-1' }));

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.ref.startsWith(`${salvageRefPrefix(BRANCH)}/`)).toBe(true);
    expect(git(repo, 'rev-parse', result.ref)).toBe(result.commit);
    expect(git(repo, 'rev-parse', `${result.commit}^`)).toBe(headBefore);
    expect(result.baseSha).toBe(headBefore);
    expect(git(repo, 'show', `${result.commit}:base.txt`)).toBe('trabalho validado');
    expect(git(repo, 'show', `${result.commit}:novo.ts`)).toBe('export const x = 1;');
    // Ignorado pelo .gitignore fica fora do snapshot.
    expect(() => git(repo, 'show', `${result.commit}:ignored.log`)).toThrow();
    expect(result.files.map((file) => file.path).sort()).toEqual(['base.txt', 'novo.ts']);
    expect(result.fileCount).toBe(2);
    // Nada do writer foi mexido: branch, índice real, arquivos, pilha de stash.
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(worktree, 'symbolic-ref', 'HEAD')).toBe(BRANCH);
    expect(git(worktree, 'status', '--porcelain=v1')).toBe(statusBefore);
    expect(fs.readFileSync(path.join(worktree, 'base.txt'), 'utf8')).toBe('trabalho validado\n');
    expect(git(repo, 'stash', 'list')).toBe('');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>', result.commit)).toBe('Nexus (salvaguarda) <salvaguarda@nexus.invalid>');
    const message = git(repo, 'log', '-1', '--format=%B', result.commit);
    expect(message).toContain('Missão: mission-a');
    expect(message).toContain('Handoff: handoff-1');
    expect(message).toContain(`Base: ${headBefore}`);
  });

  it('é idempotente para a mesma árvore e guarda um snapshot novo quando o trabalho muda', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'v1\n');
    const first = await salvageIsolatedWriterWorktree(target({ reason: 'handoff' }));
    expect(first.kind).toBe('saved');
    const again = await salvageIsolatedWriterWorktree(target());
    expect(again).toMatchObject({ kind: 'unchanged', skipped: [], untrackedOmitted: 0 });
    expect(salvageCoversWorktree(again)).toBe(true);
    expect(salvageCoversWorktree({ ...again, skipped: ['grande.bin'] } as typeof again)).toBe(false);
    expect(salvageCoversWorktree({ kind: 'clean' })).toBe(true);
    expect(salvageCoversWorktree({ kind: 'refused', reason: 'x' })).toBe(false);
    expect(salvageCoversWorktree(null)).toBe(false);
    if (first.kind !== 'saved' || again.kind !== 'unchanged') return;
    expect(again.commit).toBe(first.commit);
    expect(salvageRefs()).toHaveLength(1);

    fs.writeFileSync(path.join(worktree, 'base.txt'), 'v2\n');
    const second = await salvageIsolatedWriterWorktree(
      target({ reason: 'pane-exit' }),
      { now: () => Date.now() + 1_000 },
    );
    expect(second.kind).toBe('saved');
    // O snapshot anterior não é sobrescrito: as duas refs ficam.
    expect(salvageRefs()).toHaveLength(2);
    if (second.kind !== 'saved') return;
    expect(git(repo, 'show', `${second.commit}:base.txt`)).toBe('v2');
    expect(git(repo, 'show', `${first.commit}:base.txt`)).toBe('v1');
  });

  it('recusa branch fora de nexus/, HEAD fora da branch alocada e worktree ausente', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'x\n');
    await expect(salvageIsolatedWriterWorktree(target({ branchRef: 'refs/heads/main' })))
      .resolves.toEqual({ kind: 'refused', reason: 'branch-outside-nexus-namespace' });
    git(worktree, 'checkout', '-q', '-b', 'nexus/outra/branch');
    await expect(salvageIsolatedWriterWorktree(target()))
      .resolves.toEqual({ kind: 'refused', reason: 'worktree-head-not-on-allocated-branch' });
    await expect(salvageIsolatedWriterWorktree(target({ worktreePath: path.join(temp, 'sumiu') })))
      .resolves.toEqual({ kind: 'refused', reason: 'worktree-missing' });
    expect(salvageRefs()).toEqual([]);
  });

  it('recusa repositório com config Git executável (hooks/filtros) antes de qualquer add', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'x\n');
    git(repo, 'config', '--local', 'filter.evil.clean', 'touch /tmp/nexus-evil');
    const result = await salvageIsolatedWriterWorktree(target());
    expect(result.kind).toBe('refused');
    expect(salvageRefs()).toEqual([]);
  });

  it('deixa arquivo novo grande demais fora do snapshot e o declara', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'x\n');
    const big = path.join(worktree, 'dump.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 26 * 1024 * 1024);
    const result = await salvageIsolatedWriterWorktree(target());
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.skipped).toEqual(['dump.bin']);
    expect(() => git(repo, 'show', `${result.commit}:dump.bin`)).toThrow();
    expect(salvageNoticeSummary(target(), result)).toContain('1 arquivo(s) grande(s) ficaram fora do snapshot');
  });

  it('repo Git aninhado novo vira só gitlink no snapshot: declarado e não conta como coberto', async () => {
    const sub = path.join(worktree, 'sub');
    fs.mkdirSync(sub);
    git(sub, 'init', '-q');
    fs.writeFileSync(path.join(sub, 'only-here.txt'), 'commit só do repo interno\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'interno');
    fs.writeFileSync(path.join(worktree, 'novo.txt'), 'novo\n');
    const result = await salvageIsolatedWriterWorktree(target());
    expect(result).toMatchObject({ kind: 'saved', nestedRepos: ['sub'] });
    expect(salvageCoversWorktree(result)).toBe(false);
    const again = await salvageIsolatedWriterWorktree(target());
    expect(again).toMatchObject({ kind: 'unchanged', nestedRepos: ['sub'] });
    expect(salvageCoversWorktree(again)).toBe(false);
  });

  it('o disparo do produto registra no trace, avisa o orquestrador e nunca lança', async () => {
    const notices: unknown[] = [];
    setWorktreeSalvageNotifier((notice) => notices.push(notice));
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'x\n');
    const scope = testProjectScope({ rootRealPath: repo });
    const result = await scheduleWorktreeSalvage(target({ sessionId: 'session-1' }), { scope });
    expect(result?.kind).toBe('saved');
    expect(notices).toHaveLength(1);
    expect(traceHarness.events).toContainEqual(expect.objectContaining({
      kind: 'worktree-salvage', outcome: 'saved', reason: 'pane-exit',
      missionId: 'mission-a', sessionId: 'session-1', fileCount: 1,
    }));
    // Sem notify (varredura de reabertura): só trace.
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'y\n');
    await scheduleWorktreeSalvage(target({ reason: 'reopen-sweep' }), {
      scope, notify: false, deps: { now: () => Date.now() + 5_000 },
    });
    expect(notices).toHaveLength(1);
    // Falha de Git inesperada no meio do snapshot vira trace `error`, não exceção.
    const realGit = new AsyncProcessGitRunner();
    const broken = await scheduleWorktreeSalvage(target(), {
      deps: {
        git: {
          run: async (cwd, args, options) => {
            if (args[0] === 'status') throw new Error('git sumiu');
            return realGit.run(cwd, args, options);
          },
        },
      },
    });
    expect(broken).toBeNull();
    expect(traceHarness.events.at(-1)).toMatchObject({ kind: 'worktree-salvage', outcome: 'error' });
    // Recusa (identidade/config) também é só registro.
    const refusedRun = await scheduleWorktreeSalvage(target({ branchRef: 'refs/heads/main' }));
    expect(refusedRun).toEqual({ kind: 'refused', reason: 'branch-outside-nexus-namespace' });
    expect(traceHarness.events.at(-1)).toMatchObject({ kind: 'worktree-salvage', outcome: 'refused' });
  });

  it('o aviso diz onde está o trabalho e como integrar', async () => {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'x\n');
    const result = await salvageIsolatedWriterWorktree(target());
    if (result.kind !== 'saved') throw new Error('esperava saved');
    const summary = salvageNoticeSummary(target({ agentLabel: 'Writer F-764', reason: 'handoff' }), result);
    expect(summary).toContain('[salvaguarda]');
    expect(summary).toContain('Writer F-764');
    expect(summary).toContain(result.ref);
    expect(summary).toContain(`git cherry-pick ${result.commit.slice(0, 12)}`);
    expect(summary).toContain('base.txt');
  });
});
