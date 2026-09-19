import { describe, expect, it, vi } from 'vitest';
import {
  decideGitPrimaryAction,
  dispatchGitPrimaryAction,
  gitPrimaryActionBusyLabel,
  type GitPrimaryActionSlice,
} from './git-primary-action';

function slice(overrides: Partial<GitPrimaryActionSlice> = {}): GitPrimaryActionSlice {
  return {
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    commitMessage: '',
    hasUnresolvedConflicts: false,
    committing: false,
    remoteBusy: false,
    branch: 'feature/x',
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    defaultBranch: 'main',
    pr: null,
    ...overrides,
  };
}

describe('decideGitPrimaryAction', () => {
  it('mapeia o slice do store para o verbo certo', () => {
    expect(decideGitPrimaryAction(slice({ stagedCount: 1, commitMessage: 'ok' })).kind).toBe('commit');
    expect(decideGitPrimaryAction(slice({ unstagedCount: 2 })).kind).toBe('stage');
    expect(decideGitPrimaryAction(slice({ hasUpstream: false })).kind).toBe('publish');
    expect(decideGitPrimaryAction(slice({ ahead: 1 })).kind).toBe('push');
    expect(decideGitPrimaryAction(slice()).kind).toBe('create_pr');
  });
});

describe('gitPrimaryActionBusyLabel', () => {
  it('traduz o estado ocupado', () => {
    const d = decideGitPrimaryAction(slice({ ahead: 1 }));
    expect(gitPrimaryActionBusyLabel(d, { committing: true, remoteBusy: false, prBusy: false })).toBe('Commitando…');
    expect(gitPrimaryActionBusyLabel(d, { committing: false, remoteBusy: true, prBusy: false })).toBe('Enviando…');
  });
});

describe('dispatchGitPrimaryAction', () => {
  it('despacha commit / stage / push / pull / createPr / enqueue', async () => {
    const commit = vi.fn(async () => true);
    const stageAll = vi.fn(async () => undefined);
    const push = vi.fn(async () => true);
    const pull = vi.fn(async () => true);
    const createPr = vi.fn(async () => true);
    const enqueuePr = vi.fn(async () => true);
    const deps = { commit, stageAll, push, pull, createPr, enqueuePr };

    await dispatchGitPrimaryAction({ kind: 'commit', label: 'Commit', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'stage', label: 'Adicionar tudo', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'publish', label: 'Publicar', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'push', label: 'Enviar', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'pull', label: 'Puxar', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'create_pr', label: 'Abrir PR', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'enqueue', label: 'Enfileirar', title: '', disabled: false }, deps);
    await dispatchGitPrimaryAction({ kind: 'commit', label: 'Commit', title: '', disabled: true }, deps);

    expect(commit).toHaveBeenCalledOnce();
    expect(stageAll).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledOnce();
    expect(createPr).toHaveBeenCalledOnce();
    expect(enqueuePr).toHaveBeenCalledOnce();
  });
});
