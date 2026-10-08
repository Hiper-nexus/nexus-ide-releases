import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSources, formatReport, runMobileDoctor } from './mobile-doctor.mjs'

type Check = { id: string; ok: boolean; message: string; hint?: string }
type Report = { ok: boolean; checks: Check[] }

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots: string[] = []

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function installed(root: string, name: string, version: string, plugin = false): void {
  write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }))
  if (plugin) write(root, `node_modules/${name}/app.plugin.js`, 'module.exports = (c) => c\n')
}

const healthyExpo = () => ({
  name: 'Fixture',
  newArchEnabled: true,
  ios: {
    infoPlist: {
      NSMicrophoneUsageDescription: 'dictation',
      NSPhotoLibraryUsageDescription: 'photos',
      NSLocalNetworkUsageDescription: 'lan',
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true }
    }
  },
  android: { permissions: ['RECORD_AUDIO'] },
  plugins: [
    'expo-notifications',
    './plugins/rotation.js',
    ['expo-camera', { cameraPermission: 'scan the pairing QR' }],
    ['expo-image-picker', { photosPermission: 'photos' }]
  ]
})

/** A minimal mobile app that passes every check; each test breaks one thing. */
function fixture(mutate: (files: { expo: ReturnType<typeof healthyExpo> }) => void = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-doctor-'))
  roots.push(root)
  const files = { expo: healthyExpo() }
  mutate(files)
  write(
    root,
    'package.json',
    JSON.stringify({
      scripts: { postinstall: 'node scripts/build-engine.mjs' },
      dependencies: {
        expo: '^55.0.30',
        'expo-camera': '^55.0.0',
        'expo-image-picker': '^55.0.0',
        'expo-notifications': '^55.0.0',
        'expo-secure-store': '^55.0.0'
      }
    })
  )
  write(root, 'app.json', JSON.stringify({ expo: files.expo }))
  write(root, 'plugins/rotation.js', 'module.exports = (c) => c\n')
  installed(root, 'expo', '55.0.30')
  installed(root, 'react-native', '0.83.10')
  installed(root, 'react', '19.2.8')
  installed(root, 'expo-camera', '55.0.23', true)
  installed(root, 'expo-image-picker', '55.0.24', true)
  installed(root, 'expo-notifications', '55.0.27', true)
  installed(root, 'expo-secure-store', '55.0.18', true)
  write(root, 'app/pair-scan.tsx', "import { CameraView } from 'expo-camera'\n")
  write(
    root,
    'src/native.ts',
    [
      "import * as SecureStore from 'expo-secure-store'",
      "import * as Notifications from 'expo-notifications'",
      "import { launchImageLibraryAsync } from 'expo-image-picker'",
      "import { start } from '@orca/expo-two-way-audio'",
      "import { ENGINE } from './engine.generated'",
      ''
    ].join('\n')
  )
  write(root, 'src/engine.generated.ts', "export const ENGINE = ''\n")
  // A test that imports a module must not count as the app using it.
  write(root, 'src/only-in-tests.test.ts', "import 'expo-sensors'\n")
  return root
}

function failing(report: Report): Record<string, string | undefined> {
  return Object.fromEntries(report.checks.filter((c) => !c.ok).map((c) => [c.id, c.hint]))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mobile doctor', () => {
  it('passes a healthy app', () => {
    const report = runMobileDoctor({ root: fixture() }) as Report
    expect(failing(report)).toEqual({})
    expect(report.ok).toBe(true)
  })

  it('passes the real Nexus mobile app after install', () => {
    const report = runMobileDoctor({ root: MOBILE_ROOT }) as Report
    expect(failing(report)).toEqual({})
  })

  it('fails the SDK check when node_modules drifted from Expo 55', () => {
    const root = fixture()
    installed(root, 'expo', '54.0.12')
    expect(failing(runMobileDoctor({ root }))['expo-sdk']).toContain(
      'pnpm install --frozen-lockfile'
    )
    installed(root, 'expo', '55.0.30')
    installed(root, 'react-native', '0.81.4')
    expect(failing(runMobileDoctor({ root }))['expo-sdk']).toContain(
      'npx expo install react-native'
    )
  })

  it('fails when the New Architecture is switched off', () => {
    const root = fixture(({ expo }) => {
      expo.newArchEnabled = false
    })
    expect(failing(runMobileDoctor({ root }))['new-arch']).toContain('"newArchEnabled": true')
  })

  it('fails a camera user without a camera permission string', () => {
    const root = fixture(({ expo }) => {
      expo.plugins = expo.plugins.map((plugin) =>
        Array.isArray(plugin) && plugin[0] === 'expo-camera' ? 'expo-camera' : plugin
      )
    })
    expect(failing(runMobileDoctor({ root })).camera).toContain('cameraPermission')
  })

  it('fails when SecureStore is imported but not installed', () => {
    const root = fixture()
    rmSync(path.join(root, 'node_modules/expo-secure-store'), { recursive: true })
    expect(failing(runMobileDoctor({ root }))['secure-store']).toContain(
      'npx expo install expo-secure-store'
    )
  })

  it('fails when a used permission is not declared', () => {
    const root = fixture(({ expo }) => {
      expo.android.permissions = []
      delete (expo.ios.infoPlist as Record<string, unknown>).NSLocalNetworkUsageDescription
    })
    const report = runMobileDoctor({ root }) as Report
    const permissions = report.checks.find((c) => c.id === 'permissions')!
    expect(permissions.ok).toBe(false)
    expect(permissions.message).toContain('RECORD_AUDIO')
    expect(permissions.message).toContain('NSLocalNetworkUsageDescription')
  })

  it('fails a plugin that does not resolve', () => {
    const root = fixture(({ expo }) => {
      expo.plugins.push('./plugins/missing.js', 'expo-sensors')
    })
    const report = runMobileDoctor({ root }) as Report
    const plugins = report.checks.find((c) => c.id === 'plugins')!
    expect(plugins.message).toContain('./plugins/missing.js não existe')
    expect(plugins.message).toContain('expo-sensors não está no package.json')
  })

  it('fails when a .generated module was never built, pointing at the postinstall', () => {
    const root = fixture()
    rmSync(path.join(root, 'src/engine.generated.ts'))
    const hint = failing(runMobileDoctor({ root })).generated
    expect(hint).toContain('node scripts/build-engine.mjs')
  })

  it('skips generated native projects only at the app root', () => {
    const root = fixture()
    write(root, 'ios/Generated.swift', '')
    write(root, 'src/ios/keep.ts', '')
    const sources = (collectSources(root, root) as string[]).map((file) =>
      path.relative(root, file)
    )
    expect(sources).toContain(path.join('src', 'ios', 'keep.ts'))
    expect(sources.some((file) => file.startsWith(`ios${path.sep}`))).toBe(false)
  })

  it('exits non-zero from the CLI and prints the actionable hint', () => {
    const root = fixture(({ expo }) => {
      expo.newArchEnabled = false
    })
    const run = spawnSync(
      process.execPath,
      [path.join(MOBILE_ROOT, 'scripts/mobile-doctor.mjs'), '--root', root],
      { encoding: 'utf8' }
    )
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('FALHA new-arch')
    expect(run.stdout).toContain('dica:')
    expect(formatReport(runMobileDoctor({ root: fixture() }))).toContain('ambiente pronto')
  })
})
