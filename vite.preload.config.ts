import { defineConfig } from 'vite';

// Preload runs in a sandboxed context. It only touches `electron` (contextBridge
// + ipcRenderer) and plain shared constants, so no extra config is required.
export default defineConfig({
  server: {
    // Runtime data, never source: worker worktrees under `.dev-user-data/`
    // are full repository checkouts inside the watch root. Without this the
    // dev server rebuilds (and restarts Electron) on every worker dispatch.
    watch: {
      ignored: ['**/.dev-user-data/**', '**/.vite/**', '**/.dev-electron/**'],
    },
  },
  build: {
    rollupOptions: {
      external: ['electron'],
    },
  },
});
