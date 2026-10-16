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

  it('tracks the first successful status separately from refresh activity and resets it per workspace', async () => {
    const store = useGitScmStore.getState();
    expect(store.hasStatus).toBe(false);
    const firstRead = store.refresh();
    expect(useGitScmStore.getState()).toMatchObject({ loading: true, hasStatus: false });
    await firstRead;
    expect(useGitScmStore.getState()).toMatchObject({ loading: false, hasStatus: true, clean: true });

    const reread = store.refresh();
    expect(useGitScmStore.getState()).toMatchObject({ loading: true, hasStatus: true, clean: true });
    await reread;
    store.reset();
    expect(useGitScmStore.getState().hasStatus).toBe(false);
  });

  it('recognizes a detached HEAD as loaded and clears readiness when status fails', async () => {
    vi.mocked(window.nexus.integrations.gitStatus).mockResolvedValueOnce(okStatus({ branch: null }));
    await useGitScmStore.getState().refresh();
    expect(useGitScmStore.getState()).toMatchObject({ branch: null, hasStatus: true });
    vi.mocked(window.nexus.integrations.gitStatus).mockResolvedValueOnce({ ok: false, error: 'not a repository' });
    await useGitScmStore.getState().refresh();
    expect(useGitScmStore.getState()).toMatchObject({ hasStatus: false, error: 'not a repository', loading: false });
  });

  it('does not let an old workspace response restore its status after reset', async () => {
    let finish!: (value: ReturnType<typeof okStatus>) => void;
    vi.mocked(window.nexus.integrations.gitStatus).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refresh = useGitScmStore.getState().refresh();
    useGitScmStore.getState().reset();
    finish(okStatus());
    await refresh;
    expect(useGitScmStore.getState()).toMatchObject({ hasStatus: false, branch: null });
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
  it('mantém o diff na tela enquanto relê o mesmo arquivo e limpa ao trocar', async () => {
    let resolveDiff: (value: { ok: true; diff: string }) => void = () => {};
    Object.assign(window.nexus.integrations, {
      gitFileDiff: vi.fn(
        () => new Promise((resolve) => {
          resolveDiff = resolve;
        }),
      ),
    });
    useGitScmStore.setState({
      selected: { path: 'a.ts', section: 'unstaged' },
      diffText: 'diff antigo',
    });

    const reread = useGitScmStore.getState().selectFile({ path: 'a.ts', section: 'unstaged' });
    expect(useGitScmStore.getState().diffText).toBe('diff antigo');
    resolveDiff({ ok: true, diff: 'diff novo' });
    await reread;
    expect(useGitScmStore.getState().diffText).toBe('diff novo');

    const other = useGitScmStore.getState().selectFile({ path: 'b.ts', section: 'unstaged' });
    expect(useGitScmStore.getState().diffText).toBe('');
    resolveDiff({ ok: true, diff: 'diff de b' });
    await other;
  });
});
