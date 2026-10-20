import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorktreeRecord } from '../runtime/worktree-contract';
import type { PooledWorktreeEntry } from '../runtime/worktree-pool';
import {
  IsolatedWriterPoolOrchestrator,
  type IsolatedWriterPoolBackend,
  type PoolBaseResolution,
} from './isolated-writer-pool';
import { recordDiskSample, resetStorageHygienePolicyForTest } from '../storage-hygiene/hygiene-policy';

const SHA = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

const SCOPE: ProjectExecutionScope = {
  version: 1,
  installationId: 'installation-test',
  projectId: '11111111-1111-4111-8111-111111111111',
  checkoutId: 'checkout-pool-orch-test',
  rootRealPath: '/repo',
  identitySource: 'manifest',
};

function entry(branchRef: string, baseSha: string = SHA): PooledWorktreeEntry {
  return {
    scopeKey: 'scope-key',
    worktreePath: `/wt/pool/${branchRef.split('/').pop()}`,
    branchRef,
    baseSha,
    createdAt: 1,
  };
}

function record(entryRef: PooledWorktreeEntry): WorktreeRecord {
  return {
    ownerKind: 'pane',
    id: 'worktree-test',
    scopeKey: 'scope-key',
    projectId: SCOPE.projectId,
    checkoutId: SCOPE.checkoutId,
    missionId: 'operator-hand',
    taskId: 'pane-w',
    taskKey: 'task-key',
    workerId: 'w',
    rootRealPath: '/repo',
    worktreePath: entryRef.worktreePath,
    branchRef: entryRef.branchRef,
    integrationRef: 'refs/heads/main',
    baseSha: entryRef.baseSha,
    ownership: { files: [], symbols: [], domains: ['pane-w'] },
    dependencies: [],
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  } as WorktreeRecord;
}

function makeBackend(overrides: Partial<IsolatedWriterPoolBackend> = {}): {
  backend: IsolatedWriterPoolBackend;
  materialize: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  listPooledWorktrees: ReturnType<typeof vi.fn>;
  resolveBase: ReturnType<typeof vi.fn>;
} {
  let materializeCount = 0;
  const materialize = vi.fn(async (_scope: ProjectExecutionScope, base: PoolBaseResolution) => {
    materializeCount += 1;
    return entry(`refs/heads/nexus-pool/fresh-${materializeCount}`, base.headSha);
  });
  const claim = vi.fn(async (_scope: ProjectExecutionScope, _mission: string, entryRef: PooledWorktreeEntry) =>
    record(entryRef));
  const remove = vi.fn(async () => {});
  const listPooledWorktrees = vi.fn(async () => []);
  const resolveBase = vi.fn(async () => ({ headSha: SHA, repositoryRoot: '/repo' } as PoolBaseResolution));
  const backend: IsolatedWriterPoolBackend = {
    scopeKey: () => 'scope-key',
    worktreesRoot: () => '/wt',
    resolveBase,
    materialize,
    claim,
    remove,
    listPooledWorktrees,
    ...overrides,
  };
  return { backend, materialize, claim, remove, listPooledWorktrees, resolveBase };
}

describe('IsolatedWriterPoolOrchestrator', () => {
  afterEach(() => resetStorageHygienePolicyForTest());

  it('disco crítico: não pré-aloca (a reserva de ~1,6 GB por worktree não compensa)', async () => {
    const { backend, materialize } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    recordDiskSample({ freeBytes: 1024 ** 3, totalBytes: 500 * 1024 ** 3, sampledAt: 1 });
    await orchestrator.preallocate(SCOPE, {});
    expect(materialize).not.toHaveBeenCalled();
    expect(orchestrator.size).toBe(0);
  });

  it('adopts a pooled entry and returns the claimed record', async () => {
    const { backend, claim } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    // Pré-aloca uma entrada no HEAD atual.
    await orchestrator.preallocate(SCOPE, {});
    expect(orchestrator.size).toBe(1);

    const result = await orchestrator.tryAdopt(SCOPE, 'operator-hand', {});
    expect(result).not.toBeNull();
    expect(result?.record.branchRef).toBe('refs/heads/nexus-pool/fresh-1');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(orchestrator.size).toBe(0);
  });

  it('passes explicit target (workerId, taskId, ownership) to backend claim', async () => {
    const { backend, claim } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {});

    const target = {
      workerId: 'space-test',
      taskId: 'tab',
      ownership: { files: [], symbols: [], domains: ['space-test'] },
    };
    const result = await orchestrator.tryAdopt(SCOPE, 'space-test', {}, target);
    expect(result).not.toBeNull();
    expect(claim).toHaveBeenCalledWith(
      SCOPE,
      'space-test',
      expect.objectContaining({ baseSha: SHA }),
      target,
    );
  });

  it('falls through to null when the pool is empty', async () => {
    const { backend } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    expect(await orchestrator.tryAdopt(SCOPE, 'operator-hand', {})).toBeNull();
  });

  it('short-circuits an empty pool before resolveBase (no Git on the hot path)', async () => {
    const { backend, resolveBase, claim, remove } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    expect(await orchestrator.tryAdopt(SCOPE, 'operator-hand', {})).toBeNull();
    // resolveBase roda vários comandos Git — pool vazio não pode pagá-los.
    expect(resolveBase).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('short-circuits when the pool only holds entries of another base', async () => {
    const { backend, resolveBase, materialize, claim } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, { baseRef: 'main' });
    expect(orchestrator.size).toBe(1);
    resolveBase.mockClear();

    // Pedido de OUTRA base: nada a adotar nem a marcar stale.
    expect(
      await orchestrator.tryAdopt(SCOPE, 'operator-hand', { baseRef: 'develop' }),
    ).toBeNull();
    expect(resolveBase).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    // A entrada da base correta permanece intacta.
    expect(orchestrator.size).toBe(1);
    expect(materialize).toHaveBeenCalled();
  });

  it('discards an obsolete entry (HEAD moved) and falls through', async () => {
    const { backend, remove, resolveBase } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {}); // entrada no HEAD SHA
    expect(orchestrator.size).toBe(1);
    // O HEAD da base mudou depois da pré-alocação.
    resolveBase.mockResolvedValue({ headSha: MOVED, repositoryRoot: '/repo' });

    const result = await orchestrator.tryAdopt(SCOPE, 'operator-hand', {});
    expect(result).toBeNull();
    expect(orchestrator.size).toBe(0);
    // A entrada obsoleta é descartada fisicamente.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('discards the entry when the claim proof fails and falls through', async () => {
    const { backend, claim, remove } = makeBackend();
    claim.mockRejectedValue(new Error('pooled worktree HEAD diverged'));
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {});
    expect(orchestrator.size).toBe(1);

    const result = await orchestrator.tryAdopt(SCOPE, 'operator-hand', {});
    expect(result).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(orchestrator.size).toBe(0);
  });

  it('gives two concurrent writers distinct entries (no double handout)', async () => {
    const { backend } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    // Duas entradas pré-alocadas.
    await orchestrator.preallocate(SCOPE, {});
    await orchestrator.preallocate(SCOPE, {});

    const [first, second] = await Promise.all([
      orchestrator.tryAdopt(SCOPE, 'operator-hand', {}),
      orchestrator.tryAdopt(SCOPE, 'operator-hand', {}),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.record.worktreePath).not.toBe(second?.record.worktreePath);
    expect(orchestrator.size).toBe(0);
  });

  it('replenishes in the background after consumption', async () => {
    const { backend, materialize } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {});
    await orchestrator.tryAdopt(SCOPE, 'operator-hand', {}); // consome a entrada
    expect(orchestrator.size).toBe(0);

    orchestrator.scheduleReplenish(SCOPE, {});
    await orchestrator.idle();

    expect(materialize).toHaveBeenCalled();
    expect(orchestrator.size).toBe(1);
  });

  it('does not replenish beyond the per-scope limit', async () => {
    const { backend, materialize } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {});
    await orchestrator.preallocate(SCOPE, {});
    const materializeCount = materialize.mock.calls.length;

    orchestrator.scheduleReplenish(SCOPE, {});
    await orchestrator.idle();

    // Já no teto: nenhuma pré-alocação extra.
    expect(materialize.mock.calls.length).toBe(materializeCount);
    expect(orchestrator.size).toBe(2);
  });

  it('shuts down and removes in-memory entries physically', async () => {
    const { backend, remove } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {});
    expect(orchestrator.size).toBe(1);

    await orchestrator.shutdown();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(orchestrator.size).toBe(0);
  });

  it('boot cleanup removes orphaned pool worktrees, not in-memory entries', async () => {
    const { backend, remove, listPooledWorktrees } = makeBackend();
    listPooledWorktrees.mockResolvedValue([
      { worktreePath: '/wt/pool/orphan', branchRef: 'refs/heads/nexus-pool/orphan' },
    ]);
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true });
    await orchestrator.preallocate(SCOPE, {}); // entrada em memória

    await orchestrator.tryAdopt(SCOPE, 'operator-hand', {}); // dispara a limpeza de boot
    await orchestrator.idle();

    // Só o órfão sai; a entrada consumida (não em memória) não entra na limpeza.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1].worktreePath).toBe('/wt/pool/orphan');
  });

  it('is a no-op when disabled', async () => {
    const { backend, materialize } = makeBackend();
    const orchestrator = new IsolatedWriterPoolOrchestrator(backend, { enabled: () => false });
    await orchestrator.preallocate(SCOPE, {});
    expect(orchestrator.size).toBe(0);
    expect(await orchestrator.tryAdopt(SCOPE, 'operator-hand', {})).toBeNull();
    orchestrator.scheduleReplenish(SCOPE, {});
    await orchestrator.idle();
    expect(materialize).not.toHaveBeenCalled();
  });
});
