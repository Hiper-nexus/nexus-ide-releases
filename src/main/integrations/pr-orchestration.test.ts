import { describe, expect, it, vi } from 'vitest';
import {
  classifyGitPushError,
  orchestratePrCreation,
  type PrOrchestrationDeps,
} from './pr-orchestration';

function deps(over: Partial<PrOrchestrationDeps> = {}): PrOrchestrationDeps {
  return {
    currentBranch: () => 'feature/x',
    defaultBranch: () => 'main',
    push: () => ({ ok: true }),
    createPr: async () => ({ ok: true, url: 'https://gh/pr/1', number: 1 }),
    ...over,
  };
}

describe('orchestratePrCreation', () => {
  it('dá push da branch e cria o PR contra o default branch real', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true, url: 'u', number: 7 }));
    const r = await orchestratePrCreation({}, deps({ push, createPr, defaultBranch: () => 'trunk' }));
    expect(push).toHaveBeenCalledWith('feature/x');
    expect(createPr).toHaveBeenCalledWith({ sourceBranch: 'feature/x', targetBranch: 'trunk' });
    expect(r).toMatchObject({ ok: true, number: 7 });
  });

  it('recusa quando a branch atual é o próprio alvo (sem push, sem createPr)', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true }));
    const r = await orchestratePrCreation(
      {},
      deps({ currentBranch: () => 'main', defaultBranch: () => 'main', push, createPr }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/troque de branch/i);
    expect(push).not.toHaveBeenCalled();
    expect(createPr).not.toHaveBeenCalled();
  });

  it('falha e NÃO cria PR quando o push falha (erro tipado)', async () => {
    const createPr = vi.fn(async () => ({ ok: true }));
    const r = await orchestratePrCreation(
      {},
      deps({
        push: () => ({ ok: false, error: 'transport blocked' }),
        createPr,
        host: 'github.com',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('push');
    expect(r.githubError).toEqual({
      type: 'unknown',
      message: 'transport blocked',
    });
    expect(createPr).not.toHaveBeenCalled();
  });

  it('honra sourceBranch/targetBranch explícitos', async () => {
    const createPr = vi.fn(async () => ({ ok: true }));
    await orchestratePrCreation(
      { sourceBranch: 'fix/a', targetBranch: 'release' },
      deps({ createPr }),
    );
    expect(createPr).toHaveBeenCalledWith({ sourceBranch: 'fix/a', targetBranch: 'release' });
  });

  it('erro quando não há branch atual', async () => {
    const r = await orchestratePrCreation({}, deps({ currentBranch: () => null }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/branch/i);
  });
});

describe('orchestratePrCreation — push gate (needsPush = !isOnRemote || aheadCount > 0)', () => {
  it('NÃO dá push quando a branch já está no remote sem commits ahead', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true, url: 'u', number: 3 }));
    const r = await orchestratePrCreation(
      {},
      deps({
        branchPushState: () => ({ isOnRemote: true, aheadCount: 0 }),
        push,
        createPr,
      }),
    );
    expect(push).not.toHaveBeenCalled();
    expect(createPr).toHaveBeenCalledWith({ sourceBranch: 'feature/x', targetBranch: 'main' });
    expect(r.ok).toBe(true);
  });

  it('dá push quando a branch NÃO existe no remote', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true, url: 'u', number: 4 }));
    await orchestratePrCreation(
      {},
      deps({
        branchPushState: () => ({ isOnRemote: false, aheadCount: 0 }),
        push,
        createPr,
      }),
    );
    expect(push).toHaveBeenCalledWith('feature/x');
    expect(createPr).toHaveBeenCalled();
  });

  it('dá push quando há commits ahead mesmo com a branch no remote', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true, url: 'u', number: 5 }));
    await orchestratePrCreation(
      {},
      deps({
        branchPushState: () => ({ isOnRemote: true, aheadCount: 2 }),
        push,
        createPr,
      }),
    );
    expect(push).toHaveBeenCalledWith('feature/x');
    expect(createPr).toHaveBeenCalled();
  });

  it('sem probe branchPushState mantém o comportamento conservador (sempre push)', async () => {
    const push = vi.fn(() => ({ ok: true }));
    const createPr = vi.fn(async () => ({ ok: true }));
    await orchestratePrCreation({}, deps({ push, createPr }));
    expect(push).toHaveBeenCalledWith('feature/x');
  });
});

describe('classifyGitPushError', () => {
  it('mapeia falhas de rede para host_unreachable', () => {
    expect(
      classifyGitPushError('ssh: connect to host github.com port 22: Connection timed out', 'github.com'),
    ).toEqual({
      type: 'host_unreachable',
      host: 'github.com',
      reason: 'ssh: connect to host github.com port 22: Connection timed out',
    });
    expect(classifyGitPushError('fatal: unable to access: Could not resolve hostname', 'github.com').type).toBe(
      'host_unreachable',
    );
  });

  it('mapeia "Repository not found" para not_found', () => {
    expect(classifyGitPushError('ERROR: Repository not found.', 'github.com')).toEqual({
      type: 'not_found',
      host: 'github.com',
      message: 'ERROR: Repository not found.',
    });
  });

  it('mapeia auth/permissão para forbidden', () => {
    expect(classifyGitPushError('git@github.com: Permission denied (publickey).', 'github.com')).toEqual({
      type: 'forbidden',
      host: 'github.com',
      status: 403,
      message: 'git@github.com: Permission denied (publickey).',
    });
  });

  it('cai em unknown para o resto', () => {
    expect(classifyGitPushError('pre-receive hook declined', 'github.com')).toEqual({
      type: 'unknown',
      message: 'pre-receive hook declined',
    });
  });
});
