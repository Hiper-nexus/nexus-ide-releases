import { create } from 'zustand';
import type { FileNode } from '../../shared/files-types';

let workspaceGeneration = 0;
let selectionRequest = 0;
let directoryRequestSerial = 0;
const directoryRequests = new Map<string, number>();

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/**
 * File-explorer state: which node is open, the tree expansion, and the open
 * file's editable buffer with dirty tracking.
 */

interface OpenFile {
  relPath: string;
  content: string;
  dirty: boolean;
  loading?: boolean;
  tooLarge?: boolean;
  binary?: boolean;
  error?: string;
}

interface FilesStore {
  /** relPath → child entries (lazy-loaded on expand). */
  children: Record<string, FileNode[]>;
  expanded: Set<string>;
  openFile: OpenFile | null;
  loadErrors: Record<string, string>;
  loadingDirs: Set<string>;
  saving: boolean;

  loadDir(relPath: string): Promise<void>;
  toggleDir(relPath: string): Promise<void>;
  selectFile(relPath: string): Promise<void>;
  edit(content: string): void;
  save(): Promise<boolean>;
  reset(): void;
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  children: {},
  expanded: new Set(),
  openFile: null,
  saving: false,
  loadErrors: {},
  loadingDirs: new Set(),

  loadDir: async (relPath) => {
    if (get().loadingDirs.has(relPath)) return;

    const generation = workspaceGeneration;
    const request = ++directoryRequestSerial;
    directoryRequests.set(relPath, request);
    set((state) => {
      const loadingDirs = new Set(state.loadingDirs);
      loadingDirs.add(relPath);
      const loadErrors = { ...state.loadErrors };
      delete loadErrors[relPath];
      return { loadingDirs, loadErrors };
    });

    try {
      const res = await window.nexus.files.list(relPath);
      if (
        generation !== workspaceGeneration ||
        directoryRequests.get(relPath) !== request
      ) {
        return;
      }
      directoryRequests.delete(relPath);

      if (res.ok && res.entries) {
        const entries = res.entries;
        set((state) => {
          const loadingDirs = new Set(state.loadingDirs);
          loadingDirs.delete(relPath);
          return {
            children: { ...state.children, [relPath]: entries },
            loadingDirs,
          };
        });
        return;
      }

      set((state) => {
        const loadingDirs = new Set(state.loadingDirs);
        loadingDirs.delete(relPath);
        return {
          loadingDirs,
          loadErrors: {
            ...state.loadErrors,
            [relPath]:
              res.error ??
              'Não foi possível carregar os arquivos do workspace.',
          },
        };
      });
    } catch (error) {
      if (
        generation !== workspaceGeneration ||
        directoryRequests.get(relPath) !== request
      ) {
        return;
      }
      directoryRequests.delete(relPath);
      set((state) => {
        const loadingDirs = new Set(state.loadingDirs);
        loadingDirs.delete(relPath);
        return {
          loadingDirs,
          loadErrors: {
            ...state.loadErrors,
            [relPath]: errorMessage(
              error,
              'Não foi possível carregar os arquivos do workspace.',
            ),
          },
        };
      });
    }
  },

  toggleDir: async (relPath) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(relPath)) {
      expanded.delete(relPath);
      set({ expanded });
      return;
    }
    expanded.add(relPath);
    set({ expanded });
    if (!get().children[relPath]) await get().loadDir(relPath);
  },

  selectFile: async (relPath) => {
    const generation = workspaceGeneration;
    const request = ++selectionRequest;
    set({
      openFile: {
        relPath,
        content: '',
        dirty: false,
        loading: true,
      },
      saving: false,
    });
    try {
      const res = await window.nexus.files.read(relPath);
      if (
        generation !== workspaceGeneration ||
        request !== selectionRequest
      ) {
        return;
      }
      set({
        openFile: {
          relPath,
          content: res.content ?? '',
          dirty: false,
          loading: false,
          tooLarge: res.tooLarge,
          binary: res.binary,
          error: res.ok
            ? undefined
            : (res.error ?? 'Não foi possível abrir o arquivo.'),
        },
      });
    } catch (error) {
      if (
        generation !== workspaceGeneration ||
        request !== selectionRequest
      ) {
        return;
      }
      set({
        openFile: {
          relPath,
          content: '',
          dirty: false,
          loading: false,
          error: errorMessage(error, 'Não foi possível abrir o arquivo.'),
        },
      });
    }
  },

  edit: (content) =>
    set((state) => {
      const file = state.openFile;
      if (
        !file ||
        file.loading ||
        file.tooLarge ||
        file.binary ||
        (file.error && !file.dirty)
      ) {
        return state;
      }
      return {
        openFile: {
          ...file,
          content,
          dirty: true,
          error: undefined,
        },
      };
    }),

  save: async () => {
    const state = get();
    const file = state.openFile;
    if (
      !file ||
      !file.dirty ||
      state.saving ||
      file.loading ||
      file.tooLarge ||
      file.binary
    ) {
      return false;
    }

    const generation = workspaceGeneration;
    const request = selectionRequest;
    const { relPath, content } = file;
    set({ saving: true });

    try {
      const res = await window.nexus.files.write(relPath, content);
      if (
        generation !== workspaceGeneration ||
        request !== selectionRequest
      ) {
        return false;
      }
      const current = get().openFile;
      if (!current || current.relPath !== relPath) return false;

      if (!res.ok) {
        set((latest) =>
          latest.openFile?.relPath === relPath
            ? {
                saving: false,
                openFile: {
                  ...latest.openFile,
                  error: res.error ?? 'Não foi possível salvar o arquivo.',
                },
              }
            : latest,
        );
        return false;
      }

      const savedCurrentBuffer = current.content === content;
      set((latest) =>
        latest.openFile?.relPath === relPath
          ? {
              saving: false,
              openFile: {
                ...latest.openFile,
                dirty: savedCurrentBuffer ? false : latest.openFile.dirty,
                error: undefined,
              },
            }
          : latest,
      );
      return savedCurrentBuffer;
    } catch (error) {
      if (
        generation !== workspaceGeneration ||
        request !== selectionRequest
      ) {
        return false;
      }
      set((latest) =>
        latest.openFile?.relPath === relPath
          ? {
              saving: false,
              openFile: {
                ...latest.openFile,
                error: errorMessage(
                  error,
                  'Não foi possível salvar o arquivo.',
                ),
              },
            }
          : latest,
      );
      return false;
    }
  },

  reset: () => {
    workspaceGeneration += 1;
    selectionRequest += 1;
    directoryRequests.clear();
    set({
      children: {},
      expanded: new Set(),
      openFile: null,
      saving: false,
      loadErrors: {},
      loadingDirs: new Set(),
    });
  },
}));
