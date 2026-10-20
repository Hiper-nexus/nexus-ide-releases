import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AsyncProcessGitRunner,
  WorktreeManager,
  type AsyncGitRunner,
  WorktreeStateConflictError,
  materializeGitWorktree,
  worktreeBranchRef,
  worktreeTaskKey,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from './worktree-manager';
import { managedWorktreeRelativePath } from './managed-worktree-layout';
import { ISOLATED_WRITER_BRANCH_PREFIX } from '../orch/isolated-writer-policy';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();
  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, { revision: current.revision + 1, records: structuredClone(records) });
    return true;
  }
}

let tempDir = '';
let root = '';
let runtimeRoot = '';
let worktreesRoot = '';
let stateStore: MemoryWorktreeStateStore;
let manager: WorktreeManager;
let asyncGit: AsyncProcessGitRunner;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function headSha(): string {
  return git(root, 'rev-parse', 'HEAD');
}

function scope(): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId: PROJECT_ID,
    checkoutId: 'checkout-pool-test',
    rootRealPath: fs.realpathSync(root),
    identitySource: 'manifest',
  };
}

/** Materializa uma worktree do pool real (branch + caminho sob worktreesRoot/pool). */
async function materializePooled(name: string, atSha?: string) {
  const worktreePath = path.join(worktreesRoot, 'pool', name);
  const branchRef = `refs/heads/nexus-pool/${name}`;
  await materializeGitWorktree({
    repositoryRoot: root,
    worktreePath,
    branchRef,
    headSha: atSha ?? headSha(),
    git: asyncGit,
  });
  return { worktreePath: fs.realpathSync(worktreePath), branchRef };
}

/** Identidade CANÔNICA que create() derivaria para este worker (branch + caminho). */
function derivedIdentity(missionId: string, workerId: string) {
  const taskId = `pane-${workerId}`;
  const taskKey = worktreeTaskKey(missionId, taskId);
  const branchRef = worktreeBranchRef({
    ownerKind: 'pane',
    projectId: PROJECT_ID,
    missionId,
    taskId,
    workerId,
  });
  const worktreePath = path.join(
    // O manager resolve o caminho real (macOS: /var → /private/var); derive da
    // MESMA raiz que o claim usa.
    manager.worktreesRoot,
    managedWorktreeRelativePath(PROJECT_ID, 'checkout-pool-test', taskKey),
  );
  return { taskId, taskKey, branchRef, worktreePath };
}

/**
 * Runner que "morre" logo depois do passo `crashAfter`: o passo roda de
 * verdade e toda chamada seguinte fica pendente para sempre — o processo
 * acabou ali, então nenhum rollback em memória roda.
 */
function crashingGitRunner(crashAfter: (args: readonly string[]) => boolean) {
  let dead = false;
  let signalCrash!: () => void;
  const crashed = new Promise<void>((resolve) => { signalCrash = resolve; });
  const runner: AsyncGitRunner = {
    async run(cwd, args, options) {
      if (dead) return new Promise<never>(() => {});
      if (crashAfter(args)) {
        dead = true;
        const result = await asyncGit.run(cwd, args, options);
        signalCrash();
        await new Promise<never>(() => {});
        return result;
      }
      return asyncGit.run(cwd, args, options);
    },
  };
  return { runner, crashed };
}

/** Worktrees ligadas ao repositório: caminho real → branch. */
function linkedWorktrees(): Map<string, string> {
  const listed = new Map<string, string>();
  for (const block of git(root, 'worktree', 'list', '--porcelain').split('\n\n').slice(1)) {
    const lines = block.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? '';
    listed.set(fs.realpathSync(worktreePath), branch);
  }
  return listed;
}

function rebootManager(): WorktreeManager {
  return new WorktreeManager({
    runtimeRoot,
    worktreesRoot,
    stateStore,
    now: () => 1_700_000_000_000,
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pool-adoption-'));
  root = path.join(tempDir, 'repo');
  runtimeRoot = path.join(tempDir, 'runtime');
  worktreesRoot = path.join(runtimeRoot, 'worktrees.noindex');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(worktreesRoot, 'pool'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  stateStore = new MemoryWorktreeStateStore();
  asyncGit = new AsyncProcessGitRunner();
  manager = new WorktreeManager({
    runtimeRoot,
    worktreesRoot,
    stateStore,
    asyncGitRunner: asyncGit,
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('WorktreeManager pooled worktree adoption (A1)', () => {
  it('claims a valid pooled worktree, converting it to the canonical writer identity', async () => {
    const base = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('valid');
    const derived = derivedIdentity('operator-hand', 'worker-1');

    const record = await manager.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath: poolPath,
      branchRef: poolBranch,
      baseSha: base,
    });

    // Registro NORMAL: identidade derivada, sem marca de pool.
    expect(record.status).toBe('ready');
    expect(record.ownerKind).toBe('pane');
    expect(record.worktreePath).toBe(derived.worktreePath);
    expect(record.branchRef).toBe(derived.branchRef);
    expect(record.baseSha).toBe(base);
    expect(record.taskId).toMatch(/^pane-worker-1$/);
    expect('pooled' in record).toBe(false);

    // Registro durável aponta para a identidade derivada.
    const durable = manager.get(scope(), 'operator-hand', record.taskId);
    expect(durable?.worktreePath).toBe(derived.worktreePath);
    expect(durable?.branchRef).toBe(derived.branchRef);

    // A worktree física MOVEU para o caminho derivado e trocou de branch.
    expect(fs.existsSync(path.join(derived.worktreePath, 'README.md'))).toBe(true);
    expect(fs.existsSync(poolPath)).toBe(false);
    expect(git(derived.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(derived.branchRef);
    // A branch de pool foi renomeada (não sobra).
    expect(git(root, 'branch', '--list', 'nexus-pool/valid')).toBe('');
  });

  it('adopts with a branch in the isolated-writer namespace (salvage/tools-git identity)', async () => {
    const base = headSha();
    const { worktreePath, branchRef } = await materializePooled('namespace');
    const record = await manager.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath,
      branchRef,
      baseSha: base,
    });
    // F-794/ferramentas git: a branch precisa estar no namespace derivado `nexus/…`.
    expect(record.branchRef.startsWith(ISOLATED_WRITER_BRANCH_PREFIX)).toBe(true);
    expect(record.branchRef).toBe(worktreeBranchRef({
      ownerKind: 'pane', projectId: PROJECT_ID, missionId: 'operator-hand',
      taskId: record.taskId, workerId: record.workerId,
    }));
  });

  it('adopts for isolated tab with taskId=tab, ownerKind=pane and workerId===missionId===spaceId', async () => {
    const base = headSha();
    const spaceId = 'space-tab-pool-1';
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('tab-pool-1');

    const record = await manager.claimPooledPaneWriter(scope(), spaceId, {
      workerId: spaceId,
      taskId: 'tab',
      ownership: { files: [], symbols: [], domains: [spaceId] },
      worktreePath: poolPath,
      branchRef: poolBranch,
      baseSha: base,
    });

    expect(record.status).toBe('ready');
    expect(record.ownerKind).toBe('pane');
    expect(record.taskId).toBe('tab');
    expect(record.workerId).toBe(spaceId);
    expect(record.missionId).toBe(spaceId);
    expect(record.ownership.domains).toEqual([spaceId]);
    expect(record.branchRef).toBe(worktreeBranchRef({
      ownerKind: 'pane', projectId: PROJECT_ID, missionId: spaceId,
      taskId: 'tab', workerId: spaceId,
    }));
    expect(fs.existsSync(record.worktreePath)).toBe(true);
    expect(git(record.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(record.branchRef);
  });

  it('reverts the rename and throws when the worktree move fails (fail-closed)', async () => {
    const base = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('move-fail');
    const derived = derivedIdentity('operator-hand', 'worker-1');
    // Trava a worktree: o `git worktree move` recusa (exit 128).
    git(root, 'worktree', 'lock', poolPath);

    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: poolPath,
        branchRef: poolBranch,
        baseSha: base,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);

    // Rename revertido: a worktree segue no pool, na branch de pool, sem registro.
    expect(git(poolPath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(poolBranch);
    expect(git(root, 'branch', '--list', 'nexus-pool/move-fail')).toContain('nexus-pool/move-fail');
    expect(manager.get(scope(), 'operator-hand', derived.taskId)).toBeNull();

    // Depois de destravar, o descarte limpo continua funcionando.
    git(root, 'worktree', 'unlock', poolPath);
    await manager.removePooledWorktree(scope(), { worktreePath: poolPath, branchRef: poolBranch });
    expect(fs.existsSync(poolPath)).toBe(false);
  });

  it('registered identity conflict is refused before any Git mutation (no derived worktree/branch)', async () => {
    const base = headSha();
    // Cria um writer real com o MESMO workerId (mesma identidade derivada),
    // depois apaga a worktree e a branch físicas para simular um registro órfão:
    // a intenção durável conflita antes do branch -m/move.
    const existing = await manager.create({
      scope: scope(),
      missionId: 'operator-hand',
      taskId: 'pane-worker-1',
      workerId: 'worker-1',
      ownerKind: 'pane',
      ownership: { files: [], symbols: [], domains: ['pane-worker-1'] },
    });
    const derived = derivedIdentity('operator-hand', 'worker-1');
    git(root, 'worktree', 'remove', '--force', existing.worktreePath);
    git(root, 'branch', '-D', existing.branchRef.slice('refs/heads/'.length));

    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('cas-conflict');
    // Conta as mutações Git: recusa antes do Git ≠ rollback tardio.
    const mutations: string[] = [];
    const counting = new WorktreeManager({
      runtimeRoot,
      worktreesRoot,
      stateStore,
      asyncGitRunner: {
        run(cwd, args, options) {
          if ((args[0] === 'branch' && args[1] === '-m') || (args[0] === 'worktree' && args[1] === 'move')) {
            mutations.push(args.join(' '));
          }
          return asyncGit.run(cwd, args, options);
        },
      },
      now: () => 1_700_000_000_000,
    });

    await expect(
      counting.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: poolPath,
        branchRef: poolBranch,
        baseSha: base,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
    expect(mutations).toEqual([]);

    // Rollback completo: nada de caminho nem branch derivados órfãos.
    expect(fs.existsSync(derived.worktreePath)).toBe(false);
    expect(git(root, 'branch', '--list', derived.branchRef.slice('refs/heads/'.length))).toBe('');
    // A pré-alocada voltou ao pool, na branch de pool — descartável.
    expect(fs.existsSync(poolPath)).toBe(true);
    expect(git(poolPath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(poolBranch);
  });

  it('rejects a pooled worktree whose HEAD diverged from the claimed base', async () => {
    const { worktreePath, branchRef } = await materializePooled('stale-head');
    const original = headSha();
    // Move o checkout para um commit novo; a base da pré-alocação ficou obsoleta.
    fs.writeFileSync(path.join(root, 'README.md'), '# Moved\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'moved');
    const moved = headSha();
    expect(moved).not.toBe(original);

    // Reivindicar com a base antiga é recusado: o HEAD da worktree é o original,
    // que difere da base pedida (moved) — defesa em profundidade do claim.
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath,
        branchRef,
        baseSha: moved,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('rejects a pooled worktree outside the managed pool root', async () => {
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: outside,
        branchRef: 'refs/heads/nexus-pool/outside',
        baseSha: headSha(),
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('rejects a pooled worktree whose branch is not a pool branch', async () => {
    const { worktreePath } = await materializePooled('bad-branch');
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath,
        branchRef: 'refs/heads/nexus/not-a-pool',
        baseSha: headSha(),
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);
  });

  it('removes a pooled worktree that was never adopted', async () => {
    const { worktreePath, branchRef } = await materializePooled('discard');
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.removePooledWorktree(scope(), { worktreePath, branchRef });

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(root, 'branch', '--list', 'nexus-pool/discard')).toBe('');
  });
});

describe('WorktreeManager pooled adoption crash recovery (A1)', () => {
  const isBranchRename = (args: readonly string[]) => args[0] === 'branch' && args[1] === '-m';
  const isWorktreeMove = (args: readonly string[]) => args[0] === 'worktree' && args[1] === 'move';

  /** Adoção que "morre" logo depois de `crashAfter`; devolve a pré-alocada e a base. */
  async function crashAdoption(name: string, crashAfter: (args: readonly string[]) => boolean) {
    const base = headSha();
    const pooled = await materializePooled(name);
    const { runner, crashed } = crashingGitRunner(crashAfter);
    const dying = new WorktreeManager({
      runtimeRoot,
      worktreesRoot,
      stateStore,
      asyncGitRunner: runner,
      now: () => 1_700_000_000_000,
    });
    void dying.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath: pooled.worktreePath,
      branchRef: pooled.branchRef,
      baseSha: base,
    }).catch(() => {});
    await crashed;
    return { base, pooled };
  }

  it.each([
    ['depois do rename da branch, antes do move', isBranchRename],
    ['depois do move, antes de gravar a adoção', isWorktreeMove],
  ])('crash %s: o boot conclui a adoção na identidade derivada, sem órfã', async (_label, crashAfter) => {
    const { base } = await crashAdoption('crash', crashAfter);
    const derived = derivedIdentity('operator-hand', 'worker-1');

    // Novo processo, mesmo estado durável: a reconciliação de boot.
    const rebooted = rebootManager();
    rebooted.reconcileInterruptedReservations(scope());

    const record = rebooted.get(scope(), 'operator-hand', derived.taskId);
    expect(record).toMatchObject({
      status: 'ready',
      worktreePath: derived.worktreePath,
      branchRef: derived.branchRef,
      baseSha: base,
    });
    expect(git(derived.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(derived.branchRef);
    // Toda worktree ligada tem registro (nenhuma branch derivada esquecida em pool/).
    expect([...linkedWorktrees()]).toEqual([[derived.worktreePath, derived.branchRef]]);
  });

  it('crash antes do rename: a intenção falha fechada e a pré-alocada segue descartável pelo pool', async () => {
    const base = headSha();
    const pooled = await materializePooled('crash-before-rename');
    const derived = derivedIdentity('operator-hand', 'worker-1');
    let signalCrash!: () => void;
    const crashed = new Promise<void>((resolve) => { signalCrash = resolve; });
    const dying = new WorktreeManager({
      runtimeRoot,
      worktreesRoot,
      stateStore,
      asyncGitRunner: {
        run(cwd, args, options) {
          if (isBranchRename(args)) {
            signalCrash();
            return new Promise<never>(() => {});
          }
          return asyncGit.run(cwd, args, options);
        },
      },
      now: () => 1_700_000_000_000,
    });
    void dying.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1',
      worktreePath: pooled.worktreePath,
      branchRef: pooled.branchRef,
      baseSha: base,
    }).catch(() => {});
    await crashed;

    const rebooted = rebootManager();
    rebooted.reconcileInterruptedReservations(scope());

    // A intenção não vira writer: nada físico na identidade derivada.
    expect(rebooted.get(scope(), 'operator-hand', derived.taskId)?.status ?? 'failed').toBe('failed');
    expect(fs.existsSync(derived.worktreePath)).toBe(false);
    // A pré-alocada ficou intacta na branch de pool: a limpeza de boot do pool a remove.
    expect(git(pooled.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(pooled.branchRef);
    await rebooted.removePooledWorktree(scope(), pooled);
    expect(linkedWorktrees().size).toBe(0);
  });

  it('crash depois do rename com o checkout principal em HEAD destacado: o boot ainda leva a worktree à identidade derivada', async () => {
    const { pooled } = await crashAdoption('crash-detached', isBranchRename);
    const derived = derivedIdentity('operator-hand', 'worker-1');
    git(root, 'checkout', '-q', '--detach');

    const rebooted = rebootManager();
    rebooted.reconcileInterruptedReservations(scope());

    // A prova do checkout falha fechada (HEAD destacado), mas a worktree fica
    // no caminho registrado: o GC de writers a encontra; nada órfão em pool/.
    expect(rebooted.get(scope(), 'operator-hand', derived.taskId)?.status).toBe('failed');
    expect(fs.existsSync(pooled.worktreePath)).toBe(false);
    expect([...linkedWorktrees()]).toEqual([[derived.worktreePath, derived.branchRef]]);
  });

  it('o move de boot que falha fica registrado no log e a intenção falha fechada', async () => {
    const { pooled } = await crashAdoption('crash-locked', isBranchRename);
    const derived = derivedIdentity('operator-hand', 'worker-1');
    git(root, 'worktree', 'lock', pooled.worktreePath);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rebooted = rebootManager();
      rebooted.reconcileInterruptedReservations(scope());

      expect(rebooted.get(scope(), 'operator-hand', derived.taskId)?.status).toBe('failed');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('adoção do pool interrompida'),
        expect.objectContaining({ status: expect.any(Number) }),
      );
    } finally {
      warn.mockRestore();
      git(root, 'worktree', 'unlock', pooled.worktreePath);
    }
  });

  it('convergência só move a worktree que está sob pool/: fora dela nada sai do lugar', async () => {
    const { pooled } = await crashAdoption('crash-outside', isBranchRename);
    const derived = derivedIdentity('operator-hand', 'worker-1');
    const elsewhere = path.join(tempDir, 'elsewhere');
    git(root, 'worktree', 'move', pooled.worktreePath, elsewhere);

    const rebooted = rebootManager();
    rebooted.reconcileInterruptedReservations(scope());

    expect(rebooted.get(scope(), 'operator-hand', derived.taskId)?.status).toBe('failed');
    expect(fs.existsSync(derived.worktreePath)).toBe(false);
    expect(git(elsewhere, 'symbolic-ref', '--quiet', 'HEAD')).toBe(derived.branchRef);
  });

  /**
   * Runner cujo passo roda de verdade e mesmo assim REJEITA (o prazo do runner
   * assíncrono rejeita até com allowFailure). `stuck` recusa sem rodar.
   */
  function rejectingRunner(rejectAfterRunning: (args: readonly string[]) => boolean,
    stuck: (args: readonly string[]) => boolean = () => false): AsyncGitRunner {
    let rejected = false;
    return {
      async run(cwd, args, options) {
        if (rejected && stuck(args)) throw new Error('Git process could not complete');
        const result = await asyncGit.run(cwd, args, options);
        if (!rejected && rejectAfterRunning(args)) {
          rejected = true;
          throw new Error('Git process could not complete');
        }
        return result;
      },
    };
  }

  it.each([
    ['o rename', isBranchRename],
    ['o move', isWorktreeMove],
  ])('runner rejeita depois de %s ter rodado: desfaz e retira a intenção', async (_label, rejectAfter) => {
    const base = headSha();
    const pooled = await materializePooled('rejected');
    const derived = derivedIdentity('operator-hand', 'worker-1');
    const flaky = new WorktreeManager({
      runtimeRoot, worktreesRoot, stateStore, asyncGitRunner: rejectingRunner(rejectAfter), now: () => 1_700_000_000_000,
    });

    await expect(flaky.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1', worktreePath: pooled.worktreePath, branchRef: pooled.branchRef, baseSha: base,
    })).rejects.toThrow('Git process could not complete');

    expect(manager.get(scope(), 'operator-hand', derived.taskId)).toBeNull();
    expect([...linkedWorktrees()]).toEqual([[pooled.worktreePath, pooled.branchRef]]);
  });

  it('reversão incerta mantém a intenção para o boot, que a conclui', async () => {
    const base = headSha();
    const pooled = await materializePooled('rollback-stuck');
    const derived = derivedIdentity('operator-hand', 'worker-1');
    // O move roda e rejeita; toda limpeza seguinte de worktree trava.
    const flaky = new WorktreeManager({
      runtimeRoot, worktreesRoot, stateStore, now: () => 1_700_000_000_000,
      asyncGitRunner: rejectingRunner(isWorktreeMove,
        (args) => args[0] === 'worktree' || (args[0] === 'branch' && (args[1] === '-m' || args[1] === '-D'))),
    });

    await expect(flaky.claimPooledPaneWriter(scope(), 'operator-hand', {
      workerId: 'worker-1', worktreePath: pooled.worktreePath, branchRef: pooled.branchRef, baseSha: base,
    })).rejects.toThrow('Git process could not complete');

    // A worktree ficou na identidade derivada: a intenção não pode sumir.
    expect(manager.get(scope(), 'operator-hand', derived.taskId)?.status).toBe('reserved');
    const rebooted = rebootManager();
    rebooted.reconcileInterruptedReservations(scope());
    expect(rebooted.get(scope(), 'operator-hand', derived.taskId)?.status).toBe('ready');
    expect([...linkedWorktrees()]).toEqual([[derived.worktreePath, derived.branchRef]]);
  });
});

describe('WorktreeManager pooled adoption regression', () => {
  it('BUG 1 (HIGH): preexisting tab worktree with WIP survives when pool adoption collides', async () => {
    // Cenário: o registro SQLite sumiu, mas a worktree/branch canônica da aba
    // ainda existe com WIP (ex.: reset do registry, crash de disco).
    // A adoção do pool NÃO pode apagar essa worktree preexistente.
    const spaceId = 'space-tab-collision';
    const derived = derivedIdentity(spaceId, spaceId);

    // Cria uma worktree canônica PRÉ-EXISTENTE (simula a aba que já existia).
    // Usamos o caminho derivado EXATO que o claim derivaria para este espaço.
    git(root, 'branch', derived.branchRef.slice('refs/heads/'.length), headSha());
    git(root, 'worktree', 'add', derived.worktreePath, derived.branchRef.slice('refs/heads/'.length));
    const wipFile = path.join(derived.worktreePath, 'wip.txt');
    fs.writeFileSync(wipFile, 'trabalho não commitado da aba\n');
    const wipContent = fs.readFileSync(wipFile, 'utf8');

    // Cria uma worktree do pool para tentar adotar.
    const base = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('collision-tab');

    // Tenta adotar para o MESMO espaço: deve recusar ANTES de qualquer
    // mutação Git (a branch/pasta derivada já existem fisicamente).
    await expect(
      manager.claimPooledPaneWriter(scope(), spaceId, {
        workerId: spaceId,
        taskId: 'tab',
        ownership: { files: [], symbols: [], domains: [spaceId] },
        worktreePath: poolPath,
        branchRef: poolBranch,
        baseSha: base,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);

    // ASSERT 1: a worktree preexistente SOBREVIVE intacta.
    expect(fs.existsSync(derived.worktreePath)).toBe(true);
    expect(fs.readFileSync(wipFile, 'utf8')).toBe(wipContent);
    expect(git(derived.worktreePath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(derived.branchRef);

    // ASSERT 2: a worktree do pool também sobrevive (para descarte limpo).
    expect(fs.existsSync(poolPath)).toBe(true);
    expect(git(poolPath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(poolBranch);

    // ASSERT 3: nenhum registro de intenção foi escrito.
    expect(manager.get(scope(), spaceId, 'tab')).toBeNull();

    // ASSERT 4: o `git worktree list` ainda lista a preexistente, não a moveu.
    const linked = linkedWorktrees();
    expect(linked.has(fs.realpathSync(derived.worktreePath))).toBe(true);
  });

  it('BUG 2 (MEDIUM): commit interleaved between reserve and claim → abort and fall back to create', async () => {
    // Cenário: a reserva congela o SHA, mas entre reserve e claim
    // um commit A→B acontece no checkout principal. A worktree do pool
    // está em A; adotá-la faria a aba nascer no HEAD velho.
    const baseA = headSha();
    const { worktreePath: poolPath, branchRef: poolBranch } = await materializePooled('stale-commit', baseA);

    // Simula um commit que entra entre reserve e claim.
    fs.writeFileSync(path.join(root, 'newer.txt'), 'commit novo\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'commit interleaved B');
    const baseB = headSha();
    expect(baseB).not.toBe(baseA);

    // Tenta adotar com baseSha=A (a base da reserva, já obsoleta).
    // O claim deve detectar que repository.headSha (B) ≠ baseSha (A) e recusar.
    await expect(
      manager.claimPooledPaneWriter(scope(), 'operator-hand', {
        workerId: 'worker-1',
        worktreePath: poolPath,
        branchRef: poolBranch,
        baseSha: baseA,
      }),
    ).rejects.toBeInstanceOf(WorktreeStateConflictError);

    // ASSERT 1: a worktree do pool sobreviveu (para descarte limpo pelo pool).
    expect(fs.existsSync(poolPath)).toBe(true);
    expect(git(poolPath, 'symbolic-ref', '--quiet', 'HEAD')).toBe(poolBranch);
    expect(git(poolPath, 'rev-parse', 'HEAD')).toBe(baseA);

    // ASSERT 2: nenhum registro foi escrito.
    const derived = derivedIdentity('operator-hand', 'worker-1');
    expect(manager.get(scope(), 'operator-hand', derived.taskId)).toBeNull();

    // ASSERT 3: um create() novo usaria o HEAD atual (B), não o velho (A).
    const fresh = await manager.create({
      scope: scope(),
      missionId: 'operator-hand',
      taskId: 'pane-worker-2',
      workerId: 'worker-2',
      ownerKind: 'pane',
      ownership: { files: [], symbols: [], domains: ['pane-worker-2'] },
    });
    expect(fresh.baseSha).toBe(baseB);
  });
});
