import { defineConfig } from 'vite';

// Preload runs in a sandboxed context. It only touches `electron` (contextBridge
// + ipcRenderer) and plain shared constants, so no extra config is required.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron'],
    },
  },
});
