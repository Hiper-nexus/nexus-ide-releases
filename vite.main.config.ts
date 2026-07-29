import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

// Main process bundle. Native modules are marked external so they are required
// straight from node_modules (dev) / app.asar.unpacked (prod) instead of being
// pulled into the Rollup graph, which would break the .node binaries.
export default defineConfig({
  server: {
    // Runtime data, never source: worker worktrees under `.dev-user-data/`
    // are full repository checkouts inside the watch root. Without this the
    // dev server rebuilds (and restarts Electron) on every worker dispatch.
    watch: {
      ignored: ['**/.dev-user-data/**', '**/.vite/**', '**/.dev-electron/**'],
    },
  },
  // A chave publica de licenca e lida via process.env.NEXUS_LICENSE_PUBKEY em
  // src/main/persistence/billing-ipc.ts. Um app EMPACOTADO (.dmg) nao recebe a
  // env do shell em runtime, entao assamos o valor no bundle do main aqui:
  // `npm run make` (ou `npm start`) com NEXUS_LICENSE_PUBKEY exportada embute a
  // chave literal. Sem a env no build -> '' -> licensePublicKey() = null ->
  // fail-closed (nenhuma licenca aceita), que e o comportamento seguro.
  define: {
    'process.env.NEXUS_LICENSE_PUBKEY': JSON.stringify(
      process.env.NEXUS_LICENSE_PUBKEY ?? '',
    ),
  },
  build: {
    rollupOptions: {
      output: {
        // Electron Forge/Packager loads this exact main-process filename.
        entryFileNames: 'main.js',
      },
      // uiohook-napi / onnxruntime-node are OPTIONAL native modules for voice
      // (PTT keyup + Silero VAD). They may not be installed; marking them external
      // keeps them out of the Rollup graph so the build never tries to resolve
      // them — a runtime require() in a try/catch handles their absence.
      external: [
        '@lydell/node-pty',
        'better-sqlite3',
        'uiohook-napi',
        'onnxruntime-node',
        // Emscripten resolves its sibling .wasm from the module __dirname.
        // Keep the package external so Rollup cannot detach JS from the asset.
        '@ennuicastr/webrtcaec3.js',
        // ssh2 + optional natives (cpu-features / sshcrypto). Loaded only via
        // createSsh2Transport() require(); bundling them breaks Linux package.
        'ssh2',
        'cpu-features',
      ],
    },
  },
  resolve: {
    // tslib must bypass its exports map: the node+import condition resolves to
    // modules/index.js, which destructures the CJS default export — rolldown's
    // interop leaves .default undefined (tslib.js sets __esModule), crashing the
    // packaged app at startup. All deps use named imports, so the pure-ESM build
    // is a drop-in.
    alias: {
      tslib: require.resolve('tslib/tslib.es6.mjs'),
    },
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
