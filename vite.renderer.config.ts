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
  },
});
