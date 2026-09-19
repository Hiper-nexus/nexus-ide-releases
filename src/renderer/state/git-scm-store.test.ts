/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitScmStore } from './git-scm-store';

function okStatus(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    branch: 'feature/x',
    remote: 'https://github.com/acme/app.git',
    defaultBranch: 'main',
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
    raw: '',
    status: '',
    truncated: false,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    hasUnresolvedConflicts: false,
    ...overrides,
  };
}

describe('git-scm-store runPrimaryAction', () => {
  beforeEach(() => {
    useGitScmStore.getState().reset();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        integrations: {
          gitStatus: vi.fn(async () => okStatus()),
          gitStage: vi.fn(async () => ({ ok: true })),
          gitCommit: vi.fn(async () => ({ ok: true, summary: 'ok' })),
          gitPush: vi.fn(async () => ({ ok: true })),
          gitPull: vi.fn(async () => ({ ok: true })),
          gitDiscard: vi.fn(async () => ({ ok: true })),
          gitBranches: vi.fn(async () => ({ ok: true, current: 'main', branches: ['main', 'feature/x'] })),
          gitCheckout: vi.fn(async () => ({ ok: true })),
          gitLog: vi.fn(async () => ({
            ok: true,
            commits: [{ hash: 'abc', subject: 'feat: login' }],
          })),
          createPr: vi.fn(async () => ({ ok: true, url: 'https://gh/pr/1', number: 1 })),
          inspectPr: vi.fn(async () => ({ ok: true, branch: 'feature/x', review: null })),
          enqueuePr: vi.fn(async () => ({ ok: true, action: 'when-ready', number: 8 })),
        },
      },
    });
  });

  it('faz stage all quando o verbo é Adicionar tudo', async () => {
    useGitScmStore.setState({
      unstaged: [{ path: 'a.ts', status: 'M' }],
      clean: false,
    });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitStage).toHaveBeenCalled();
  });

  it('commita quando há staged e mensagem', async () => {
    useGitScmStore.setState({
      staged: [{ path: 'a.ts', status: 'M' }],
      commitMessage: 'feat: x',
      clean: false,
    });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitCommit).toHaveBeenCalledWith('feat: x');
  });

  it('gera PR local e chama createPr', async () => {
    useGitScmStore.setState({
      branch: 'feature/x',
      hasUpstream: true,
      defaultBranch: 'main',
      ahead: 0,
      behind: 0,
      clean: true,
    });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitLog).toHaveBeenCalled();
    expect(window.nexus.integrations.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'feat: login',
        body: expect.stringContaining('## Problem'),
      }),
    );
  });

  it('envia a branch quando há commits ahead', async () => {
    useGitScmStore.setState({ ahead: 2, hasUpstream: true, branch: 'feature/x' });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitPush).toHaveBeenCalled();
  });

  it('enfileira um PR aberto quando a fila está disponível', async () => {
    useGitScmStore.setState({
      branch: 'feature/x',
      hasUpstream: true,
      defaultBranch: 'main',
      pr: {
        number: 8,
        url: 'https://gh/pr/8',
        title: 'feat: login',
        state: 'open',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        autoMergeEnabled: false,
        autoMergeAllowed: true,
        mergeQueueRequired: true,
        stacked: false,
      },
    });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.enqueuePr).toHaveBeenCalledWith({
      mode: 'when-ready',
    });
  });

  it('puxa commits quando a branch está atrás (pull)', async () => {
    useGitScmStore.setState({ behind: 3, hasUpstream: true, branch: 'feature/x' });
    const ok = await useGitScmStore.getState().runPrimaryAction();
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitPull).toHaveBeenCalled();
  });

  it('descarta alterações via discard()', async () => {
    const ok = await useGitScmStore.getState().discard(['file.ts']);
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitDiscard).toHaveBeenCalledWith(['file.ts']);
  });

  it('carrega branches e alterna de branch', async () => {
    await useGitScmStore.getState().loadBranches();
    expect(useGitScmStore.getState().branches).toEqual(['main', 'feature/x']);

    const ok = await useGitScmStore.getState().checkout('feature/x');
    expect(ok).toBe(true);
    expect(window.nexus.integrations.gitCheckout).toHaveBeenCalledWith('feature/x', false);
  });
});
