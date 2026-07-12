import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer runs React 18 in an isolated, sandboxed BrowserWindow.
export default defineConfig({
  plugins: [react()],
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
