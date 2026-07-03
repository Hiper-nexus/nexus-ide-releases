import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer runs React 18 in an isolated, sandboxed BrowserWindow.
export default defineConfig({
  plugins: [react()],
});
