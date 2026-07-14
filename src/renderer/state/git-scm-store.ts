import { create } from 'zustand';
import type {
  GitFileChange,
  GitLogEntry,
} from '../../shared/git-scm';

export type GitScmTab = 'changes' | 'history';

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
  commits: GitLogEntry[];
  commitMessage: string;
  selected: SelectedGitFile | null;
  diffText: string;
  loading: boolean;
  mutating: boolean;
  committing: boolean;
  error: string | null;

  setTab(tab: GitScmTab): void;
  setCommitMessage(message: string): void;
  refresh(): Promise<void>;
  selectFile(file: SelectedGitFile): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  stageAll(section: 'unstaged' | 'untracked' | 'all'): Promise<void>;
  unstageAll(): Promise<void>;
  commit(): Promise<boolean>;
  reset(): void;
}

function emptyLists() {
  return {
    staged: [] as GitFileChange[],
    unstaged: [] as GitFileChange[],
    untracked: [] as GitFileChange[],
    clean: true,
    truncated: false,
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
  error: null,

  setTab: (tab) => {
    set({ tab });
    if (tab === 'history') void get().refresh();
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
      });

      if (get().tab === 'history') {
        const log = await api.gitLog(30);
        if (seq !== refreshSeq) return;
        if (log.ok) set({ commits: log.commits });
        else set({ error: log.error });
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
        error: err instanceof Error ? err.message : 'falha ao ler git status',
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
        error: err instanceof Error ? err.message : 'falha ao ler diff',
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
        error: err instanceof Error ? err.message : 'falha ao fazer stage',
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
        error: err instanceof Error ? err.message : 'falha ao remover do stage',
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
        error: err instanceof Error ? err.message : 'falha ao fazer stage',
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
        error: err instanceof Error ? err.message : 'falha ao remover do stage',
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
        error: err instanceof Error ? err.message : 'falha no commit',
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
      error: null,
    });
  },
}));
