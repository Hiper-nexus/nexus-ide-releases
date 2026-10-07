import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer runs React 18 in an isolated, sandboxed BrowserWindow.
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      /**
       * Worker worktrees are materialized under `.dev-user-data/` — inside the
       * repository, therefore inside Vite's watch root. Each one is a full
       * checkout, so the moment a mission dispatched a worker the dev server
       * saw hundreds of new files (including tsconfig.json, which forces a
       * cache clear + full reload) and put the renderer into a reload storm:
       * the window went black and never finished navigating
       * ("renderer sem navegação ativa"), while the mission itself kept
       * running fine in main. Runtime data is never renderer source.
       */
      ignored: ['**/.dev-user-data/**', '**/.vite/**', '**/.dev-electron/**'],
    },
  },
  // O worker de realce do diff (@pierre/diffs/worker/worker.js?worker) importa
  // a gramática/engine sob demanda; workers IIFE não aceitam code-splitting.
  // Módulo ES servido de 'self' cabe no CSP do renderer (worker-src 'self' blob:).
  worker: { format: 'es' },
  build: {
    // AudioWorklet modules are loaded as scripts at runtime. Inlining `?url`
    // assets as data: URLs makes production CSP reject addModule(), silently
    // degrading mic capture to the high-latency ScriptProcessor fallback.
    assetsInlineLimit: 0,
    rollupOptions: {
      // Duas janelas, um bundle de renderer: a principal (index.html) e o
      // desktop pet (pet.html) — servidas pelo mesmo dev server no dev e
      // pelo protocolo nexus-app:// no pacote.
      input: {
        index: 'index.html',
        pet: 'pet.html',
      },
    },
  },
});
