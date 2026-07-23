import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';
import { notarize } from '@electron/notarize';
import type { ForgeConfig, ForgeMakeResult } from '@electron-forge/shared-types';
import {
  MakerSquirrel,
  type MakerSquirrelConfig,
} from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG, type MakerDMGConfig } from '@electron-forge/maker-dmg';
import { MakerDeb, type MakerDebConfig } from '@electron-forge/maker-deb';
import { MakerRpm, type MakerRpmConfig } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { WindowsSignOptions } from '@electron/packager';
import { pruneNativePayload } from './build/prune-native-payload';
import { removeUnusedMacPrivacyDescriptions } from './build/macos-info-plist';
import {
  assertMacPublishReleaseEnvironment,
  createMacSignOptions,
  isAppleReleaseSigning,
} from './build/mac-signing';

const MICROPHONE_USAGE_DESCRIPTION =
  'NexusIDE uses the microphone for push-to-talk voice commands (Jarvis mode).';
const SCREEN_CAPTURE_USAGE_DESCRIPTION =
  'NexusIDE uses screen capture to give Jarvis visual context of your workspace.';
const APP_BUNDLE_ID = 'com.nexuside.app';
const REQUIRED_WAKE_MODEL_FILE = 'ei-jarvis-ptbr.onnx';

export function assertRequiredWakeResource(resourcesDir: string): void {
  const manifestPath = path.join(resourcesDir, 'wake', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion?: unknown;
    defaultModel?: Record<string, unknown>;
  };
  const model = manifest.defaultModel;
  if (
    manifest.schemaVersion !== 1 ||
    model?.file !== REQUIRED_WAKE_MODEL_FILE ||
    model.locale !== 'pt-BR' ||
    model.required !== true ||
    model.wakePhrase !== 'Ei Jarvis' ||
    typeof model.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(model.sha256)
  ) {
    throw new Error('release wake manifest does not declare the required PT-BR default');
  }
  const bytes = readFileSync(path.join(resourcesDir, 'wake', REQUIRED_WAKE_MODEL_FILE));
  const observedHash = createHash('sha256').update(bytes).digest('hex');
  if (observedHash !== model.sha256) {
    throw new Error(`release PT-BR wake model checksum mismatch: ${observedHash}`);
  }
}

function packagedMacApps(outputPaths: readonly string[]): string[] {
  return outputPaths.flatMap((outputPath) => {
    if (outputPath.endsWith('.app')) return [outputPath];
    if (!existsSync(outputPath) || !statSync(outputPath).isDirectory()) return [];
    return readdirSync(outputPath)
      .filter((entry) => entry.endsWith('.app'))
      .map((entry) => path.join(outputPath, entry));
  });
}

export function shouldPackageFile(file: string): boolean {
  if (!file) return true;
  // Electron Packager passes POSIX paths on Unix and backslash paths on
  // Windows. Keep the inclusion policy identical across release runners.
  const normalized = file.replaceAll('\\', '/');
  const rootRelative = normalized.replace(/^[A-Za-z]:/u, '');
  return (
    rootRelative === '/package.json' ||
    rootRelative === '/LICENSE' ||
    rootRelative === '/THIRD_PARTY_NOTICES.md' ||
    rootRelative === '/third_party' ||
    rootRelative === '/third_party/licenses' ||
    rootRelative.startsWith('/third_party/licenses/') ||
    (rootRelative.includes('/.vite/') || rootRelative.endsWith('/.vite')) ||
    rootRelative.includes('/node_modules/') ||
    rootRelative === '/node_modules'
  );
}

type MacNotarizeCredentials = { readonly keychainProfile: string };

type NotarizeArtifact = (
  options: { readonly appPath: string } & MacNotarizeCredentials,
) => Promise<void>;

export function createMacNotarizeCredentials(
  environment: NodeJS.ProcessEnv,
): MacNotarizeCredentials | undefined {
  if (!isAppleReleaseSigning(environment.APPLE_TEAM_ID)) return undefined;
  const { keychainProfile } =
    assertMacPublishReleaseEnvironment(environment);
  return { keychainProfile };
}

export function createMacDmgMakerConfig(
  environment: NodeJS.ProcessEnv,
): MakerDMGConfig {
  const teamId = environment.APPLE_TEAM_ID;
  return {
    format: 'ULFO',
    icon: 'assets/icon.icns',
    ...(isAppleReleaseSigning(teamId)
      ? {
          additionalDMGOptions: {
            'code-sign': {
              'signing-identity': createMacSignOptions(teamId).identity as string,
              identifier: APP_BUNDLE_ID,
            },
          },
        }
      : {}),
  };
}

export function createLinuxDebMakerConfig(): MakerDebConfig {
  return { options: { depends: ['bubblewrap'] } };
}

export function createLinuxRpmMakerConfig(): MakerRpmConfig {
  return { options: { requires: ['bubblewrap'] } };
}

export async function notarizeMacDmgArtifacts(
  makeResults: ForgeMakeResult[],
  environment: NodeJS.ProcessEnv,
  notarizeArtifact: NotarizeArtifact = notarize,
): Promise<ForgeMakeResult[]> {
  const credentials = createMacNotarizeCredentials(environment);
  if (!credentials) return makeResults;
  const dmgs = makeResults
    .filter((result) => result.platform === 'darwin')
    .flatMap((result) => result.artifacts)
    .filter((artifact) => artifact.toLowerCase().endsWith('.dmg'));
  if (dmgs.length !== 1) {
    throw new Error(`macOS release must produce exactly one DMG; found ${dmgs.length}.`);
  }
  await notarizeArtifact({ appPath: path.resolve(dmgs[0]), ...credentials });
  return makeResults;
}

type WindowsReleaseSignOptions = WindowsSignOptions & {
  continueOnError: false;
};

function requiredWindowsSigningValue(
  environment: NodeJS.ProcessEnv,
  name: 'WINDOWS_CERTIFICATE_FILE' | 'WINDOWS_CERTIFICATE_PASSWORD',
): string {
  const value = environment[name];
  if (!value || (name === 'WINDOWS_CERTIFICATE_FILE' && !value.trim())) {
    throw new Error(`${name} is required for Windows release signing.`);
  }
  return name === 'WINDOWS_CERTIFICATE_FILE' ? value.trim() : value;
}

export function createWindowsSignOptions(
  environment: NodeJS.ProcessEnv,
): WindowsReleaseSignOptions | undefined {
  const mode = environment.NEXUS_WINDOWS_RELEASE_SIGNING;
  if (mode === undefined) return undefined;
  if (mode !== '1') {
    throw new Error('NEXUS_WINDOWS_RELEASE_SIGNING must be exactly "1".');
  }
  return {
    certificateFile: requiredWindowsSigningValue(
      environment,
      'WINDOWS_CERTIFICATE_FILE',
    ),
    certificatePassword: requiredWindowsSigningValue(
      environment,
      'WINDOWS_CERTIFICATE_PASSWORD',
    ),
    continueOnError: false,
    hashes: [
      'sha256' as NonNullable<WindowsSignOptions['hashes']>[number],
    ],
    timestampServer: 'http://timestamp.digicert.com',
  };
}

const windowsSignOptions = createWindowsSignOptions(
  process.platform === 'win32' ? process.env : {},
);
const squirrelWindowsSignOptions = windowsSignOptions
  ? (({ continueOnError: _continueOnError, ...options }) => options)(
      windowsSignOptions,
    )
  : undefined;
const macNotarizeCredentials = createMacNotarizeCredentials(process.env);

const config: ForgeConfig = {
  hooks: {
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const removed = pruneNativePayload(buildPath, platform, arch);
      if (removed.length > 0) {
        console.log(`[package] pruned ${removed.length} foreign ONNX runtime payloads`);
      }
      const removedPrivacyDescriptions = removeUnusedMacPrivacyDescriptions(
        buildPath,
        platform,
      );
      if (removedPrivacyDescriptions.length > 0) {
        console.log(
          `[package] removed ${removedPrivacyDescriptions.length} unused macOS privacy declarations`,
        );
      }
    },
    postPackage: async (_forgeConfig, packageResult) => {
      const appPaths = packageResult.platform === 'darwin'
        ? packagedMacApps(packageResult.outputPaths)
        : [];
      const resourceDirs = packageResult.platform === 'darwin'
        ? appPaths.map((appPath) => path.join(appPath, 'Contents', 'Resources'))
        : packageResult.outputPaths.map((outputPath) =>
            path.join(outputPath, 'resources'));
      if (resourceDirs.length === 0) {
        throw new Error('release package produced no resource directory to validate');
      }
      for (const resourcesDir of resourceDirs) {
        assertRequiredWakeResource(resourcesDir);
      }

      if (
        process.platform !== 'darwin' ||
        packageResult.platform !== 'darwin' ||
        isAppleReleaseSigning(process.env.APPLE_TEAM_ID)
      ) return;

      for (const outputPath of appPaths) {
        // Fuses modify the main executable after Packager's first signing pass.
        // Re-sign the full hierarchy so each Mach-O keeps its class-specific
        // entitlement profile; a blanket `codesign --deep --entitlements`
        // would copy the app's microphone grant into every helper/library.
        await signAsync({
          app: outputPath,
          ...createMacSignOptions(undefined),
        });
      }
    },
    postMake: async (_forgeConfig, makeResults) =>
      notarizeMacDmgArtifacts(makeResults, process.env),
  },
  packagerConfig: {
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: 'public.app-category.developer-tools',
    // Keep the packaged binary aligned with the Linux makers and the stable
    // command name. productName still controls the user-facing app label.
    executableName: 'nexus-ide',
    // design-system-sensor: runtime helper
    // resources/wake: head PT-BR ONNX (também embutido em base64 no main;
    // o arquivo em extraResource permite inspeção/override sem rebuild).
    extraResource: [
      'scripts/design-system-sensor.mjs',
      'resources/wake',
      'resources/model-ranking.json',
      // Pacote de ~15 pets Codex v2 offline (manifest + sheets/*.webp).
      'resources/pets',
    ],
    // App icon (nó-nexus pixel: anel + núcleo aceso + satélites): packager
    // appends .icns on macOS. Read at build time from the project root — not
    // shipped inside the asar.
    icon: 'assets/icon',
    // Natives cannot execute from inside the asar: unpack .node binaries and
    // node-pty's spawn-helper executable. Using packager's own asar.unpack
    // (instead of the AutoUnpackNativesPlugin) keeps the ElectronAsarIntegrity
    // hash in Info.plist consistent — the plugin repacks the asar AFTER the
    // hash is computed, which trips the integrity fuse into a silent hang.
    asar: {
      // *.dylib: onnxruntime-node (wake word) dlopens libonnxruntime beside
      // its .node binding — both must live outside the asar.
      unpack: '**/{*.node,*.dylib,*.so*,*.wasm,spawn-helper,tesseract.js/**,tesseract.js-core/**,wasm-feature-detect/**}',
      // node-pty also ships an executable helper on POSIX and multiple conpty
      // bindings on Windows. Unpack the complete platform package so runtime
      // resolution never depends on per-file glob behavior.
      unpackDir: '**/node_modules/@lydell/{node-pty,node-pty-*}',
    },
    // plugin-vite's default ignore ships ONLY the .vite bundles, silently
    // dropping the runtime externals (@lydell/node-pty, better-sqlite3, …).
    // Ship node_modules too; packager's prune keeps production deps only.
    ignore: (file: string) => !shouldPackageFile(file),
    // Voice capture: macOS shows this string on the first mic-permission prompt.
    // The matching hardened-runtime entitlement lives in the app and Renderer
    // Helper profiles; getUserMedia executes in that helper. Helper/native
    // profiles are selected by build/mac-signing.ts. Present here so an ad-hoc
    // dev build still prompts.
    extendInfo: {
      CFBundleName: 'NexusIDE',
      CFBundleDisplayName: 'NexusIDE',
      // Keep AppKit's launch classification explicit. Without this key, some
      // macOS launches inherit an accessory/UIElement policy even after the main
      // process calls app.setActivationPolicy('regular').
      LSUIElement: false,
      // Keep ATS active for all remote traffic. The app uses loopback HTTP for
      // its embedded MCP endpoint and the verified local Squirrel feed only.
      // `NSAllowsLocalNetworking` preserves those local product services
      // without disabling TLS requirements for arbitrary remote origins.
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
      NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
      NSScreenCaptureUsageDescription: SCREEN_CAPTURE_USAGE_DESCRIPTION,
      CFBundleURLTypes: [
        {
          CFBundleURLName: 'com.nexuside.app',
          CFBundleURLSchemes: ['nexus'],
        },
      ],
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Markdown Document',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['net.daringfireball.markdown', 'public.markdown'],
          CFBundleTypeExtensions: ['md', 'markdown'],
        },
        {
          CFBundleTypeName: 'Text Document',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.plain-text', 'public.text'],
          CFBundleTypeExtensions: ['txt', 'log'],
        },
        {
          CFBundleTypeName: 'Code or Config Document',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.json', 'public.yaml', 'public.source-code'],
          CFBundleTypeExtensions: ['json', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx'],
        },
      ],
    },
    extendHelperInfo: {
      NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
      NSScreenCaptureUsageDescription: SCREEN_CAPTURE_USAGE_DESCRIPTION,
    },
    // Code signing always runs so extendInfo changes are bound into the app
    // signature. Without Apple credentials this is ad-hoc (`identity: '-'`):
    // good for local validation, still not distributable through Gatekeeper.
    // Notarization activates ONLY through the explicit local publish target.
    // Release builds require NEXUS_MAC_PUBLISH_RELEASE=1, the exact Team ID and
    // the exact "nexus-notary" keychain profile (see build/notarize.md).
    // Developer ID releases use hardened runtime. A local ad-hoc signature has
    // no stable Team ID, so hardened library validation would reject Electron's
    // own frameworks at dyld time; keep it off only for that non-distributable
    // validation package.
    osxSign: createMacSignOptions(process.env.APPLE_TEAM_ID),
    ...(windowsSignOptions ? { windowsSign: windowsSignOptions } : {}),
    ...(macNotarizeCredentials
      ? {
          // Publication is local-only and keychain-backed. Environment
          // passwords and CI fallbacks are deliberately not supported.
          osxNotarize: macNotarizeCredentials,
        }
      : {}),
  },
  // macOS: rebuild paralelo faz módulos nativos compartilharem/removerem
  // `build/node_gyp_bins`, causando ENOENT intermitente no start do Dev.
  rebuildConfig: { mode: 'sequential' },
  makers: [
    // .dmg is the installable macOS artifact; ZIP doubles as the
    // Squirrel.Mac auto-update payload.
    // Code signing/notarization (osxSign/osxNotarize in packagerConfig)
    // activates when a Developer ID identity is present on the build machine.
    new MakerDMG(createMacDmgMakerConfig(process.env), ['darwin']),
    new MakerSquirrel(
      squirrelWindowsSignOptions
        ? {
            windowsSign:
              squirrelWindowsSignOptions as NonNullable<
                MakerSquirrelConfig['windowsSign']
              >,
          }
        : {},
    ),
    new MakerZIP({}, ['darwin']),
    new MakerRpm(createLinuxRpmMakerConfig()),
    new MakerDeb(createLinuxDebMakerConfig()),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main-bootstrap.ts', config: 'vite.main.config.ts', target: 'main' },
        // PTY host: separate utilityProcess entry, built beside main.js as
        // .vite/build/pty-host-entry.js (docs/ARCHITECTURE.md §B.2).
        { entry: 'src/main/pty/pty-host-entry.ts', config: 'vite.pty-host.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
        // Remote pages run in their own sandboxed WebContentsView. This preload
        // exposes no page API; it only accepts the closed browser-automation IPC
        // contract from main, keeping model input out of executeJavaScript.
        { entry: 'src/preload/browser-preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
        // Desktop pet: preload mínimo (prefs/eventos/drag) — a janela do pet
        // nunca vê o contrato completo do window.nexus.
        { entry: 'src/preload/pet-preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // Hardening fuses: no Node in the renderer, no inspector, load app only
    // from the signed asar. This is the production security baseline.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
