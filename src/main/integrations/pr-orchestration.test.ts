import { describe, expect, it, vi } from 'vitest';
import { orchestratePrCreation, type PrOrchestrationDeps } from './pr-orchestration';

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

  it('falha e NÃO cria PR quando o push falha', async () => {
    const createPr = vi.fn(async () => ({ ok: true }));
    const r = await orchestratePrCreation(
      {},
      deps({ push: () => ({ ok: false, error: 'transport blocked' }), createPr }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('push');
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
