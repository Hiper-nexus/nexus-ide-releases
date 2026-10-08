#!/usr/bin/env node
// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: de scripts/mobile-native-static-check.ts ficam a varredura de fontes (collectSources com diretórios excluídos e android/ios gerados só na raiz) e o padrão "ferramenta ausente → dica de instalação"; sem Effect, em Node puro, e no lugar de swiftlint/ktlint checa o ambiente Expo do app (SDK, New Architecture, câmera, SecureStore, permissões declaradas, config plugins e arquivos .generated), falhando com dica acionável.
//
// Usage: node scripts/mobile-doctor.mjs [--root <mobile-dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXPECTED_EXPO_SDK = 55
// What Expo SDK 55 ships with; a drift here is a native build that cannot link.
const SDK_RUNTIME_LINES = { 'react-native': '0.83.', react: '19.2.' }
const INSTALL_HINT = 'Rode `pnpm install --frozen-lockfile` em mobile/.'

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const excludedDirectories = new Set([
  '.expo',
  '.git',
  'build',
  'DerivedData',
  'node_modules',
  'Pods',
  'Vendor'
])
const generatedNativeProjectDirectories = new Set(['android', 'ios'])
const SOURCE_ROOTS = ['app', 'src']

export function collectSources(directory, root) {
  const sources = []
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry)
    const stat = statSync(entryPath)
    if (stat.isDirectory()) {
      const isGeneratedNativeProjectDirectory =
        directory === root && generatedNativeProjectDirectories.has(entry)
      if (excludedDirectories.has(entry) || isGeneratedNativeProjectDirectory) {
        continue
      }
      sources.push(...collectSources(entryPath, root))
      continue
    }
    if (stat.isFile() && sourceExtensions.has(path.extname(entry))) {
      sources.push(entryPath)
    }
  }
  return sources
}

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function installedVersion(root, name) {
  const manifest = path.join(root, 'node_modules', name, 'package.json')
  return existsSync(manifest) ? String(readJson(manifest).version ?? '') : null
}

function majorOf(range) {
  const match = /(\d+)/.exec(String(range ?? ''))
  return match ? Number(match[1]) : null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function pluginEntries(expo) {
  return (expo.plugins ?? []).map((entry) =>
    Array.isArray(entry)
      ? { name: entry[0], options: entry[1] ?? {} }
      : { name: entry, options: {} }
  )
}

function pluginOptions(expo, name) {
  return pluginEntries(expo).find((plugin) => plugin.name === name)?.options ?? null
}

/** app.json first, then app.config.js on top of it — the same order Expo uses. */
function loadExpoConfig(root) {
  const appJson = path.join(root, 'app.json')
  let expo = existsSync(appJson) ? (readJson(appJson).expo ?? {}) : {}
  const appConfig = path.join(root, 'app.config.js')
  if (existsSync(appConfig)) {
    const exported = createRequire(appConfig)(appConfig)
    const resolved = typeof exported === 'function' ? exported({ config: expo }) : exported
    expo = resolved?.expo ?? resolved ?? expo
  }
  return expo
}

function scanSources(root) {
  const files = SOURCE_ROOTS.map((dir) => path.join(root, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => collectSources(dir, root))
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
  const imports = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]
      if (!imports.has(specifier)) imports.set(specifier, [])
      imports.get(specifier).push(file)
    }
  }
  const uses = (name) => imports.has(name)
  const usesText = (pattern) => files.some((file) => pattern.test(readFileSync(file, 'utf8')))
  return { imports, uses, usesText }
}

function check(id, ok, message, hint) {
  return ok ? { id, ok, message } : { id, ok, message, hint }
}

function checkExpoSdk(root, pkg) {
  const declared = pkg.dependencies?.expo
  const installed = installedVersion(root, 'expo')
  if (majorOf(declared) !== EXPECTED_EXPO_SDK) {
    return check(
      'expo-sdk',
      false,
      `package.json pede expo ${declared ?? '(ausente)'}; o app é do SDK ${EXPECTED_EXPO_SDK}.`,
      `Volte a faixa para "^${EXPECTED_EXPO_SDK}.0.0" ou migre o app inteiro com \`npx expo install --fix\`.`
    )
  }
  if (installed === null || majorOf(installed) !== EXPECTED_EXPO_SDK) {
    return check(
      'expo-sdk',
      false,
      `node_modules tem expo ${installed ?? '(não instalado)'}, esperado SDK ${EXPECTED_EXPO_SDK}.`,
      INSTALL_HINT
    )
  }
  for (const [name, line] of Object.entries(SDK_RUNTIME_LINES)) {
    const version = installedVersion(root, name)
    if (version === null || !version.startsWith(line)) {
      return check(
        'expo-sdk',
        false,
        `${name} ${version ?? '(não instalado)'} não é a linha ${line}x do SDK ${EXPECTED_EXPO_SDK}.`,
        `Alinhe com \`npx expo install ${name}\` e depois ${INSTALL_HINT}`
      )
    }
  }
  return check('expo-sdk', true, `Expo SDK ${EXPECTED_EXPO_SDK} (expo ${installed}).`)
}

function checkNewArch(expo) {
  return expo.newArchEnabled === false
    ? check(
        'new-arch',
        false,
        'newArchEnabled está false.',
        'Defina "newArchEnabled": true em app.json: Reanimated 4/worklets e o SDK 55 só rodam na New Architecture.'
      )
    : check('new-arch', true, 'New Architecture ativa.')
}

function checkCamera(expo, scan) {
  if (!scan.uses('expo-camera')) {
    return check('camera', true, 'expo-camera não é usado.')
  }
  const options = pluginOptions(expo, 'expo-camera')
  const declared =
    nonEmpty(options?.cameraPermission) || nonEmpty(expo.ios?.infoPlist?.NSCameraUsageDescription)
  const blocked = (expo.android?.blockedPermissions ?? []).some((permission) =>
    /(^|\.)CAMERA$/.test(permission)
  )
  if (!declared || blocked) {
    return check(
      'camera',
      false,
      blocked
        ? 'android.blockedPermissions remove CAMERA, mas o app usa expo-camera.'
        : 'O app usa expo-camera sem texto de permissão de câmera.',
      'Adicione ["expo-camera", { "cameraPermission": "…" }] em plugins do app.json e tire CAMERA de android.blockedPermissions.'
    )
  }
  return check('camera', true, 'Câmera declarada (expo-camera).')
}

function checkSecureStore(root, pkg, expo, scan) {
  if (!scan.uses('expo-secure-store')) {
    return check('secure-store', true, 'expo-secure-store não é usado.')
  }
  if (
    !pkg.dependencies?.['expo-secure-store'] ||
    installedVersion(root, 'expo-secure-store') === null
  ) {
    return check(
      'secure-store',
      false,
      'O app importa expo-secure-store, mas o pacote não está declarado/instalado.',
      `Rode \`npx expo install expo-secure-store\` em mobile/ e depois ${INSTALL_HINT}`
    )
  }
  if (
    scan.usesText(/requireAuthentication\s*:\s*true/) &&
    !nonEmpty(expo.ios?.infoPlist?.NSFaceIDUsageDescription) &&
    !nonEmpty(pluginOptions(expo, 'expo-secure-store')?.faceIDPermission)
  ) {
    return check(
      'secure-store',
      false,
      'SecureStore com requireAuthentication sem texto de Face ID.',
      'Adicione ["expo-secure-store", { "faceIDPermission": "…" }] em plugins do app.json.'
    )
  }
  return check('secure-store', true, 'SecureStore instalado.')
}

function checkPermissions(expo, scan) {
  const infoPlist = expo.ios?.infoPlist ?? {}
  const androidPermissions = new Set(
    (expo.android?.permissions ?? []).map((permission) =>
      permission.replace(/^android\.permission\./, '')
    )
  )
  const missing = []
  if (scan.uses('@orca/expo-two-way-audio') || scan.uses('expo-audio')) {
    const cameraOptions = pluginOptions(expo, 'expo-camera')
    if (
      !nonEmpty(infoPlist.NSMicrophoneUsageDescription) &&
      !nonEmpty(cameraOptions?.microphonePermission)
    ) {
      missing.push('ios.infoPlist.NSMicrophoneUsageDescription (ditado por voz)')
    }
    if (!androidPermissions.has('RECORD_AUDIO')) {
      missing.push('android.permissions RECORD_AUDIO (ditado por voz)')
    }
  }
  if (scan.uses('expo-image-picker')) {
    if (
      !nonEmpty(infoPlist.NSPhotoLibraryUsageDescription) &&
      !nonEmpty(pluginOptions(expo, 'expo-image-picker')?.photosPermission)
    ) {
      missing.push('ios.infoPlist.NSPhotoLibraryUsageDescription (anexar fotos)')
    }
  }
  if (
    infoPlist.NSAppTransportSecurity?.NSAllowsLocalNetworking === true &&
    !nonEmpty(infoPlist.NSLocalNetworkUsageDescription)
  ) {
    missing.push('ios.infoPlist.NSLocalNetworkUsageDescription (pareamento na LAN)')
  }
  if (scan.uses('expo-notifications') && pluginOptions(expo, 'expo-notifications') === null) {
    missing.push('plugin expo-notifications (canais Android e entitlement de push)')
  }
  return missing.length > 0
    ? check(
        'permissions',
        false,
        `Faltam declarações: ${missing.join('; ')}.`,
        'Declare cada uma em app.json (ios.infoPlist / android.permissions / plugins); sem isso o iOS encerra o app no primeiro pedido e o Android nega em silêncio.'
      )
    : check('permissions', true, 'Permissões usadas pelo código estão declaradas.')
}

function checkPlugins(root, pkg, expo) {
  const problems = []
  for (const { name } of pluginEntries(expo)) {
    if (typeof name !== 'string' || name.length === 0) {
      problems.push('entrada de plugin inválida')
      continue
    }
    if (name.startsWith('.') || name.startsWith('/')) {
      if (!existsSync(path.resolve(root, name))) problems.push(`${name} não existe`)
      continue
    }
    const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
    if (!declared) {
      problems.push(`${name} não está no package.json`)
    } else if (installedVersion(root, name) === null) {
      problems.push(`${name} não está instalado`)
    } else if (!existsSync(path.join(root, 'node_modules', name, 'app.plugin.js'))) {
      problems.push(`${name} não exporta app.plugin.js`)
    }
  }
  return problems.length > 0
    ? check(
        'plugins',
        false,
        `Config plugins quebrados: ${problems.join('; ')}.`,
        `Corrija o caminho em app.json ou instale o pacote com \`npx expo install <pacote>\`; depois ${INSTALL_HINT}`
      )
    : check('plugins', true, `${pluginEntries(expo).length} config plugins resolvidos.`)
}

function checkGenerated(root, pkg, scan) {
  const missing = []
  for (const [specifier, files] of scan.imports) {
    if (!specifier.startsWith('.') || !/\.generated$/.test(specifier)) continue
    for (const file of files) {
      const base = path.resolve(path.dirname(file), specifier)
      const found = ['.ts', '.tsx', '.js', '.mjs'].some((extension) => existsSync(base + extension))
      if (!found) missing.push(path.relative(root, base))
    }
  }
  const unique = [...new Set(missing)]
  const postinstall = pkg.scripts?.postinstall
  return unique.length > 0
    ? check(
        'generated',
        false,
        `Arquivos gerados ausentes: ${unique.join(', ')}.`,
        postinstall
          ? `Gere-os com \`${postinstall}\` em mobile/ (é o postinstall: ${INSTALL_HINT})`
          : INSTALL_HINT
      )
    : check('generated', true, 'Arquivos .generated presentes.')
}

export function runMobileDoctor({ root }) {
  const checks = []
  let pkg = {}
  try {
    pkg = readJson(path.join(root, 'package.json'))
  } catch (error) {
    checks.push(
      check(
        'package',
        false,
        `package.json ilegível: ${error.message}`,
        'Rode o doctor com --root apontando para mobile/.'
      )
    )
    return { ok: false, checks }
  }
  let expo
  try {
    expo = loadExpoConfig(root)
  } catch (error) {
    checks.push(
      check(
        'app-config',
        false,
        `app.json/app.config.js falhou: ${error.message}`,
        'Corrija o JSON ou o app.config.js e rode de novo.'
      )
    )
    return { ok: false, checks }
  }
  const scan = scanSources(root)
  checks.push(
    checkExpoSdk(root, pkg),
    checkNewArch(expo),
    checkCamera(expo, scan),
    checkSecureStore(root, pkg, expo, scan),
    checkPermissions(expo, scan),
    checkPlugins(root, pkg, expo),
    checkGenerated(root, pkg, scan)
  )
  return { ok: checks.every((result) => result.ok), checks }
}

export function formatReport(result) {
  const lines = result.checks.map((item) =>
    item.ok
      ? `ok    ${item.id}: ${item.message}`
      : `FALHA ${item.id}: ${item.message}\n      dica: ${item.hint}`
  )
  lines.push(
    result.ok ? 'mobile doctor: ambiente pronto.' : 'mobile doctor: corrija as falhas acima.'
  )
  return lines.join('\n')
}

function rootFromArgs(argv) {
  const index = argv.indexOf('--root')
  if (index !== -1 && argv[index + 1]) return path.resolve(argv[index + 1])
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = runMobileDoctor({ root: rootFromArgs(process.argv.slice(2)) })
  console.log(formatReport(result))
  process.exitCode = result.ok ? 0 : 1
}
