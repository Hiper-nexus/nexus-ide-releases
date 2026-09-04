import { create } from 'zustand';

export interface TerminalGridDialogOptions {
  readonly initialCount?: number;
  readonly replaceExisting?: boolean;
}

interface TerminalGridDialogStore {
  readonly isOpen: boolean;
  readonly options: TerminalGridDialogOptions;
  open(options?: TerminalGridDialogOptions): void;
  close(): void;
}

export const useTerminalGridDialogStore = create<TerminalGridDialogStore>((set) => ({
  isOpen: false,
  options: {},
  open: (options = {}) => set({ isOpen: true, options }),
  close: () => set({ isOpen: false, options: {} }),
}));
