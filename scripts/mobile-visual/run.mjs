#!/usr/bin/env node
// F-1035 — harness visual + E2E do host Nexus no app mobile (docs/MOBILE-VISUAL.md).
//
//   npm run mobile:visual                 export web + fluxo + screenshots
//   npm run mobile:visual -- --no-build   reaproveita mobile/web-build
//   npm run mobile:visual -- --serve      só sobe bridge + app (uso manual)
//
// 1) `expo export --platform web` com EXPO_PUBLIC_NEXUS_VISUAL_HARNESS=1 (a única
//    forma de aceitar o host 127.0.0.1 no pareamento — só no alvo web);
// 2) esbuild empacota main.ts trocando os cinco módulos que dependem do Electron
//    por desktop-fakes.ts (os mesmos que remote-bridge.mobile-app.test.ts simula);
// 3) roda: Remote Bridge real + Chrome headless + screenshots em
//    docs/qa/evidence/mobile-web/.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const mobile = path.join(repo, 'mobile')
const webRoot = path.join(mobile, 'web-build')
const args = new Set(process.argv.slice(2))

if (!args.has('--no-build') || !fs.existsSync(path.join(webRoot, 'index.html'))) {
  const localExpo = path.join(mobile, 'node_modules', '.bin', 'expo')
  const [cmd, cmdArgs] = fs.existsSync(localExpo) ? [localExpo, []] : ['npx', ['expo']]
  console.log('› expo export --platform web (EXPO_PUBLIC_NEXUS_VISUAL_HARNESS=1)')
  const result = spawnSync(
    cmd,
    // --clear: a flag é embutida no bundle pelo babel; o cache do Metro não a considera.
    [...cmdArgs, 'export', '--platform', 'web', '--output-dir', 'web-build', '--clear'],
    {
      cwd: mobile,
      stdio: 'inherit',
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_NEXUS_VISUAL_HARNESS: '1' }
    }
  )
  if (result.status !== 0) {
    console.error('✗ expo export falhou')
    process.exit(result.status ?? 1)
  }
}

// O esbuild vem da instalação da raiz (dependência do Vite).
const { build } = createRequire(path.join(repo, 'package.json'))('esbuild')
const FAKED = [
  'src/main/orch/pane-registry',
  'src/main/orch/pane-authz',
  'src/main/orch/project-domain-store-registry',
  'src/main/pty/pty-manager',
  'src/main/remote/remote-desktop-confirmation'
].map((relative) => path.join(repo, relative))
const fakes = path.join(here, 'desktop-fakes.ts')
const outfile = path.join(os.tmpdir(), 'nexus-mobile-visual', 'harness.cjs')

await build({
  entryPoints: [path.join(here, 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [
    {
      name: 'nexus-desktop-fakes',
      setup(b) {
        // `original-fs` só existe no Electron; fora dele é o fs normal (como no vitest).
        b.onResolve({ filter: /^original-fs$/ }, () => ({ path: 'node:fs', external: true }))
        // Fora do Electron, `require('electron')` não traz `app`/`ipcMain` (no vitest é a
        // string do binário). Módulos que só os usam dentro de funções carregam igual.
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
          contents: 'module.exports = {}',
          loader: 'js'
        }))
        b.onResolve(
          { filter: /(pane-registry|pane-authz|project-domain-store-registry|pty-manager|remote-desktop-confirmation)$/ },
          (resolveArgs) => {
            const absolute = path.resolve(resolveArgs.resolveDir, resolveArgs.path)
            return FAKED.includes(absolute) ? { path: fakes } : undefined
          }
        )
      }
    }
  ]
})

process.setSourceMapsEnabled(true)
const harness = createRequire(import.meta.url)(outfile)
const code = await harness.main({ repo, webRoot, serve: args.has('--serve') })
process.exit(code)
