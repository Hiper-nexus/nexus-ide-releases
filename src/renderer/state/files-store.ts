import { create } from 'zustand';
import type { FileNode } from '../../shared/files-types';

/**
 * File-explorer state: which node is open, the tree expansion, and the open
 * file's editable buffer with dirty tracking.
 */

interface OpenFile {
  relPath: string;
  content: string;
  dirty: boolean;
  tooLarge?: boolean;
  binary?: boolean;
  error?: string;
}

interface FilesStore {
  open: boolean;
  /** relPath → child entries (lazy-loaded on expand). */
  children: Record<string, FileNode[]>;
  expanded: Set<string>;
  openFile: OpenFile | null;
  saving: boolean;

  togglePanel(): void;
  closePanel(): void;
  loadDir(relPath: string): Promise<void>;
  toggleDir(relPath: string): Promise<void>;
  selectFile(relPath: string): Promise<void>;
  edit(content: string): void;
  save(): Promise<void>;
  reset(): void;
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  open: false,
  children: {},
  expanded: new Set(),
  openFile: null,
  saving: false,

  togglePanel: () => {
    const next = !get().open;
    set({ open: next });
    if (next && !get().children['']) void get().loadDir('');
  },
  closePanel: () => set({ open: false }),

  loadDir: async (relPath) => {
    const res = await window.nexus.files.list(relPath);
    if (res.ok && res.entries) {
      set((s) => ({ children: { ...s.children, [relPath]: res.entries! } }));
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
    const res = await window.nexus.files.read(relPath);
    set({
      openFile: {
        relPath,
        content: res.content ?? '',
        dirty: false,
        tooLarge: res.tooLarge,
        binary: res.binary,
        error: res.ok ? undefined : res.error,
      },
    });
  },

  edit: (content) =>
    set((s) =>
      s.openFile
        ? { openFile: { ...s.openFile, content, dirty: true } }
        : s,
    ),

  save: async () => {
    const file = get().openFile;
    if (!file || !file.dirty) return;
    set({ saving: true });
    const res = await window.nexus.files.write(file.relPath, file.content);
    set({ saving: false });
    if (res.ok) {
      set((s) =>
        s.openFile
          ? { openFile: { ...s.openFile, dirty: false, error: undefined } }
          : s,
      );
    } else {
      set((s) =>
        s.openFile ? { openFile: { ...s.openFile, error: res.error } } : s,
      );
    }
  },

  reset: () =>
    set({ children: {}, expanded: new Set(), openFile: null, open: false }),
}));
