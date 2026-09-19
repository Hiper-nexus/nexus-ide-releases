import { gitErrorCopy } from '../lib/git-error-copy';
import { create } from 'zustand';
import type {
  GitFileChange,
  GitLogEntry,
} from '../../shared/git-scm';
import type { ExternalIssue, ForgePrInspect } from '../../shared/integrations-types';
import { generateLocalPullRequestFields } from '../../shared/pull-request-generation';
import {
  decideGitPrimaryAction,
  dispatchGitPrimaryAction,
} from './git-primary-action';

export type GitScmTab = 'changes' | 'history' | 'issues';

export type SelectedGitFile = {
  path: string;
  section: 'staged' | 'unstaged' | 'untracked';
};

interface GitScmStore {
  tab: GitScmTab;
  branch: string | null;
  remote: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  clean: boolean;
  truncated: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasUnresolvedConflicts: boolean;
  defaultBranch: string | null;
  remoteBusy: boolean;
  commits: GitLogEntry[];
  commitMessage: string;
  selected: SelectedGitFile | null;
  diffText: string;
  loading: boolean;
  mutating: boolean;
  committing: boolean;
  error: string | null;
  pr: ForgePrInspect | null;
  prBusy: boolean;
  prError: string | null;

  setTab(tab: GitScmTab): void;
  setCommitMessage(message: string): void;
  refresh(): Promise<void>;
  selectFile(file: SelectedGitFile): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  stageAll(section: 'unstaged' | 'untracked' | 'all'): Promise<void>;
  unstageAll(): Promise<void>;
  commit(): Promise<boolean>;
  pushCurrentBranch(): Promise<boolean>;
  pull(): Promise<boolean>;
  discard(paths: string[]): Promise<boolean>;
  createPrFromDraft(): Promise<boolean>;
  runPrimaryAction(): Promise<boolean>;
  enqueuePr(mode?: 'when-ready' | 'now'): Promise<boolean>;
  setAutoMerge(enabled: boolean): Promise<boolean>;
  branches: string[];
  branchesLoading: boolean;
  loadBranches(): Promise<void>;
  checkout(branch: string, create?: boolean): Promise<boolean>;
  pulling: boolean;
  issues: ExternalIssue[];
  issuesError: string | null;
  issuesLoading: boolean;
  refreshIssues(): Promise<void>;
  reset(): void;
}

function emptyLists() {
  return {
    staged: [] as GitFileChange[],
    unstaged: [] as GitFileChange[],
    untracked: [] as GitFileChange[],
    clean: true,
    truncated: false,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    hasUnresolvedConflicts: false,
    defaultBranch: null as string | null,
    branch: null as string | null,
    remote: null as string | null,
  };
}

let refreshSeq = 0;
let selectSeq = 0;

export const useGitScmStore = create<GitScmStore>((set, get) => ({
  tab: 'changes',
  ...emptyLists(),
  commits: [],
  commitMessage: '',
  selected: null,
  diffText: '',
  loading: false,
  mutating: false,
  committing: false,
  remoteBusy: false,
  pulling: false,
  branches: [],
  branchesLoading: false,
  error: null,
  pr: null,
  prBusy: false,
  prError: null,
  issues: [],
  issuesError: null,
  issuesLoading: false,

  setTab: (tab) => {
    set({ tab });
    if (tab === 'history') void get().refresh();
    if (tab === 'issues') void get().refreshIssues();
  },

  setCommitMessage: (commitMessage) => set({ commitMessage }),

  refresh: async () => {
    const api = window.nexus?.integrations;
    if (!api?.gitStatus) {
      set({ error: 'API git indisponível', ...emptyLists() });
      return;
    }
    const seq = ++refreshSeq;
    set({ loading: true, error: null });
    try {
      const status = await api.gitStatus();
      if (seq !== refreshSeq) return;
      if (!status.ok) {
        set({ loading: false, error: status.error, ...emptyLists() });
        return;
      }
      const selected = get().selected;
      set({
        loading: false,
        branch: status.branch,
        remote: status.remote,
        staged: status.staged ?? [],
        unstaged: status.unstaged ?? [],
        untracked: status.untracked ?? [],
        clean: status.clean ?? false,
        truncated: status.truncated ?? false,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
        hasUpstream: status.hasUpstream ?? false,
        hasUnresolvedConflicts: status.hasUnresolvedConflicts ?? false,
        defaultBranch: status.defaultBranch ?? null,
      });

      if (get().tab === 'history') {
        const log = await api.gitLog(30);
        if (seq !== refreshSeq) return;
        if (log.ok) set({ commits: log.commits });
        else set({ error: log.error });
      }

      const inspect = api.inspectPr;
      if (inspect) {
        try {
          const pr = await inspect();
          if (seq !== refreshSeq) return;
          if (pr.ok) set({ pr: pr.review, prError: null });
          else set({ pr: null, prError: pr.error });
        } catch {
          if (seq === refreshSeq) set({ pr: null, prError: null });
        }
      }

      if (selected) {
        const stillThere =
          (selected.section === 'staged' &&
            (status.staged ?? []).some((f) => f.path === selected.path)) ||
          (selected.section === 'unstaged' &&
            (status.unstaged ?? []).some((f) => f.path === selected.path)) ||
          (selected.section === 'untracked' &&
            (status.untracked ?? []).some((f) => f.path === selected.path));
        if (stillThere) await get().selectFile(selected);
        else if (seq === refreshSeq) set({ selected: null, diffText: '' });
      }
    } catch (err) {
      if (seq !== refreshSeq) return;
      set({
        loading: false,
        error: gitErrorCopy(err, 'status').message,
        ...emptyLists(),
      });
    }
  },

  selectFile: async (file) => {
    const api = window.nexus?.integrations;
    const seq = ++selectSeq;
    set({ selected: file, diffText: '', error: null });
    if (!api?.gitFileDiff) return;
    try {
      const result = await api.gitFileDiff({
        path: file.path,
        staged: file.section === 'staged',
        untracked: file.section === 'untracked',
      });
      if (seq !== selectSeq) return;
      if (!result.ok) {
        set({ error: result.error, diffText: '' });
        return;
      }
      if (result.untracked) {
        set({
          diffText: `(arquivo não rastreado)\n${file.path}`,
        });
        return;
      }
      set({
        diffText: result.diff.trim()
          ? result.diff
          : '(sem diff — arquivo sem alterações nesta seção)',
      });
    } catch (err) {
      if (seq !== selectSeq) return;
      set({
        error: gitErrorCopy(err, 'diff').message,
      });
    }
  },

  stage: async (paths) => {
    const api = window.nexus?.integrations;
    if (!api?.gitStage || paths.length === 0) return;
    set({ mutating: true, error: null });
    try {
      const r = await api.gitStage(paths);
      if (!r.ok) set({ error: r.error });
    } catch (err) {
      set({
        error: gitErrorCopy(err, 'stage').message,
      });
    } finally {
      set({ mutating: false });
      await get().refresh();
    }
  },

  unstage: async (paths) => {
    const api = window.nexus?.integrations;
    if (!api?.gitUnstage || paths.length === 0) return;
    set({ mutating: true, error: null });
    try {
      const r = await api.gitUnstage(paths);
      if (!r.ok) set({ error: r.error });
    } catch (err) {
      set({
        error: gitErrorCopy(err, 'unstage').message,
      });
    } finally {
      set({ mutating: false });
      await get().refresh();
    }
  },

  stageAll: async (section) => {
    const api = window.nexus?.integrations;
    const { unstaged, untracked } = get();
    if (!api?.gitStage) return;
    const paths =
      section === 'unstaged'
        ? unstaged.map((f) => f.path)
        : section === 'untracked'
          ? untracked.map((f) => f.path)
          : [
              ...unstaged.map((f) => f.path),
              ...untracked.map((f) => f.path),
            ];
    if (paths.length === 0) return;

    set({ mutating: true, error: null });
    try {
      // "." only for combined "all" — never for a single section.
      if (section === 'all' && paths.length > 80) {
        const r = await api.gitStage(['.']);
        if (!r.ok) set({ error: r.error });
      } else {
        const chunkSize = 200;
        for (let i = 0; i < paths.length; i += chunkSize) {
          const r = await api.gitStage(paths.slice(i, i + chunkSize));
          if (!r.ok) {
            set({ error: r.error });
            break;
          }
        }
      }
    } catch (err) {
      set({
        error: gitErrorCopy(err, 'stage').message,
      });
    } finally {
      set({ mutating: false });
      await get().refresh();
    }
  },

  unstageAll: async () => {
    const api = window.nexus?.integrations;
    const paths = get().staged.map((f) => f.path);
    if (!api?.gitUnstage || paths.length === 0) return;
    set({ mutating: true, error: null });
    try {
      const r = await api.gitUnstage(paths.length > 80 ? ['.'] : paths);
      if (!r.ok) set({ error: r.error });
    } catch (err) {
      set({
        error: gitErrorCopy(err, 'unstage').message,
      });
    } finally {
      set({ mutating: false });
      await get().refresh();
    }
  },

  commit: async () => {
    const api = window.nexus?.integrations;
    const message = get().commitMessage.trim();
    if (!api?.gitCommit || !message) {
      set({ error: 'Escreva uma mensagem de commit' });
      return false;
    }
    if (get().staged.length === 0) {
      set({ error: 'Nada no stage — adicione arquivos antes de commitar' });
      return false;
    }
    set({ committing: true, error: null });
    try {
      const r = await api.gitCommit(message);
      if (!r.ok) {
        set({ committing: false, error: r.error });
        return false;
      }
      set({ committing: false, commitMessage: '' });
      await get().refresh();
      return true;
    } catch (err) {
      set({
        committing: false,
        error: gitErrorCopy(err, 'commit').message,
      });
      return false;
    }
  },

  pushCurrentBranch: async () => {
    const api = window.nexus?.integrations;
    if (!api?.gitPush) {
      set({ error: 'API git push indisponível' });
      return false;
    }
    set({ remoteBusy: true, error: null });
    try {
      const r = await api.gitPush();
      if (!r.ok) {
        set({ remoteBusy: false, error: r.error });
        return false;
      }
      set({ remoteBusy: false });
      await get().refresh();
      return true;
    } catch (err) {
      set({
        remoteBusy: false,
        error: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  pull: async () => {
    const api = window.nexus?.integrations;
    if (!api?.gitPull) {
      set({ error: 'API git pull indisponível' });
      return false;
    }
    set({ remoteBusy: true, pulling: true, error: null });
    try {
      const r = await api.gitPull();
      set({ remoteBusy: false, pulling: false });
      if (!r.ok) {
        set({ error: r.error });
        return false;
      }
      await get().refresh();
      return true;
    } catch (err) {
      set({
        remoteBusy: false,
        pulling: false,
        error: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  discard: async (paths) => {
    const api = window.nexus?.integrations;
    if (!api?.gitDiscard) {
      set({ error: 'API git discard indisponível' });
      return false;
    }
    set({ mutating: true, error: null });
    try {
      const r = await api.gitDiscard(paths);
      set({ mutating: false });
      if (!r.ok) {
        set({ error: r.error });
        return false;
      }
      await get().refresh();
      return true;
    } catch (err) {
      set({
        mutating: false,
        error: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  loadBranches: async () => {
    const api = window.nexus?.integrations;
    if (!api?.gitBranches) return;
    set({ branchesLoading: true });
    try {
      const res = await api.gitBranches();
      if (res.ok) {
        set({ branches: res.branches, branchesLoading: false });
      } else {
        set({ branchesLoading: false });
      }
    } catch {
      set({ branchesLoading: false });
    }
  },

  checkout: async (branch, create = false) => {
    const api = window.nexus?.integrations;
    if (!api?.gitCheckout) {
      set({ error: 'API git checkout indisponível' });
      return false;
    }
    set({ mutating: true, error: null });
    try {
      const r = await api.gitCheckout(branch, create);
      set({ mutating: false });
      if (!r.ok) {
        set({ error: r.error });
        return false;
      }
      await get().refresh();
      await get().loadBranches();
      return true;
    } catch (err) {
      set({
        mutating: false,
        error: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  createPrFromDraft: async () => {
    const api = window.nexus?.integrations;
    if (!api?.createPr) {
      set({ error: 'API de PR indisponível' });
      return false;
    }
    set({ remoteBusy: true, error: null, prError: null });
    try {
      const log = await api.gitLog(20);
      const commits = log.ok ? log.commits : get().commits;
      const draft = generateLocalPullRequestFields({
        branch: get().branch,
        base: get().defaultBranch ?? 'main',
        commits,
      });
      const r = await api.createPr({
        title: draft.title,
        body: draft.body,
        draft: draft.draft,
      });
      if (!r.ok) {
        set({ remoteBusy: false, error: r.error, prError: r.error });
        return false;
      }
      set({ remoteBusy: false });
      await get().refresh();
      return true;
    } catch (err) {
      const message = gitErrorCopy(err).message;
      set({ remoteBusy: false, error: message, prError: message });
      return false;
    }
  },

  runPrimaryAction: async () => {
    const s = get();
    const decision = decideGitPrimaryAction({
      stagedCount: s.staged.length,
      unstagedCount: s.unstaged.length,
      untrackedCount: s.untracked.length,
      commitMessage: s.commitMessage,
      hasUnresolvedConflicts: s.hasUnresolvedConflicts,
      committing: s.committing,
      remoteBusy: s.remoteBusy,
      branch: s.branch,
      hasUpstream: s.hasUpstream,
      ahead: s.ahead,
      behind: s.behind,
      defaultBranch: s.defaultBranch,
      pr: s.pr,
    });
    return dispatchGitPrimaryAction(decision, {
      commit: () => get().commit(),
      stageAll: () => get().stageAll('all'),
      push: () => get().pushCurrentBranch(),
      pull: () => get().pull(),
      createPr: () => get().createPrFromDraft(),
      enqueuePr: () => get().enqueuePr('when-ready'),
    });
  },

  refreshIssues: async () => {
    const api = window.nexus?.integrations;
    if (!api?.listGithubIssues && !api?.listLinearIssues) {
      set({ issuesError: 'API de issues indisponível', issues: [] });
      return;
    }
    set({ issuesLoading: true, issuesError: null });
    try {
      const [gh, linear] = await Promise.all([
        api.listGithubIssues?.({ limit: 20, state: 'open' }).catch(() => null),
        api.listLinearIssues?.({ limit: 20 }).catch(() => null),
      ]);
      const issues: ExternalIssue[] = [];
      if (gh?.ok) issues.push(...gh.issues);
      if (linear?.ok) issues.push(...linear.issues);
      const err =
        (gh && !gh.ok ? gh.error : null) ||
        (linear && !linear.ok ? linear.error : null);
      set({
        issuesLoading: false,
        issues,
        issuesError: issues.length === 0 ? err : null,
      });
    } catch (err) {
      set({
        issuesLoading: false,
        issues: [],
        issuesError: gitErrorCopy(err).message,
      });
    }
  },

  enqueuePr: async (mode) => {
    const api = window.nexus?.integrations;
    if (!api?.enqueuePr) {
      set({ prError: 'API de PR indisponível' });
      return false;
    }
    set({ prBusy: true, prError: null });
    try {
      const r = await api.enqueuePr({ mode });
      if (!r.ok) {
        set({ prBusy: false, prError: r.error });
        return false;
      }
      set({ prBusy: false });
      await get().refresh();
      return true;
    } catch (err) {
      set({
        prBusy: false,
        prError: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  setAutoMerge: async (enabled) => {
    const api = window.nexus?.integrations;
    if (!api?.setAutoMerge) {
      set({ prError: 'API de PR indisponível' });
      return false;
    }
    set({ prBusy: true, prError: null });
    try {
      const r = await api.setAutoMerge({ enabled });
      if (!r.ok) {
        set({ prBusy: false, prError: r.error });
        return false;
      }
      set({ prBusy: false });
      await get().refresh();
      return true;
    } catch (err) {
      set({
        prBusy: false,
        prError: gitErrorCopy(err).message,
      });
      return false;
    }
  },

  reset: () => {
    refreshSeq += 1;
    selectSeq += 1;
    set({
      tab: 'changes',
      ...emptyLists(),
      commits: [],
      commitMessage: '',
      selected: null,
      diffText: '',
      loading: false,
      mutating: false,
      committing: false,
      remoteBusy: false,
      pulling: false,
      branches: [],
      branchesLoading: false,
      error: null,
      pr: null,
      prBusy: false,
      prError: null,
      issues: [],
      issuesError: null,
      issuesLoading: false,
    });
  },
}));
