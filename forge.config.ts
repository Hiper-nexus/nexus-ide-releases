import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (
        process.platform !== 'darwin' ||
        packageResult.platform !== 'darwin' ||
        process.env.APPLE_TEAM_ID
      ) {
        return;
      }
      const appPaths = packageResult.outputPaths.flatMap((outputPath) => {
        if (outputPath.endsWith('.app')) return [outputPath];
        if (!existsSync(outputPath) || !statSync(outputPath).isDirectory()) {
          return [];
        }
        return readdirSync(outputPath)
          .filter((entry) => entry.endsWith('.app'))
          .map((entry) => path.join(outputPath, entry));
      });

      for (const outputPath of appPaths) {
        execFileSync('codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          outputPath,
        ], { stdio: 'inherit' });
      }
    },
  },
  packagerConfig: {
    appBundleId: 'com.nexuside.app',
    appCategoryType: 'public.app-category.developer-tools',
    // App icon (Matrix-hacker mark): packager appends .icns on macOS. Read at
    // build time from the project root — not shipped inside the asar.
    icon: 'assets/icon',
    // Natives cannot execute from inside the asar: unpack .node binaries and
    // node-pty's spawn-helper executable. Using packager's own asar.unpack
    // (instead of the AutoUnpackNativesPlugin) keeps the ElectronAsarIntegrity
    // hash in Info.plist consistent — the plugin repacks the asar AFTER the
    // hash is computed, which trips the integrity fuse into a silent hang.
    asar: {
      // *.dylib: onnxruntime-node (wake word) dlopens libonnxruntime beside
      // its .node binding — both must live outside the asar.
      unpack: '**/{*.node,*.dylib,spawn-helper}',
    },
    // plugin-vite's default ignore ships ONLY the .vite bundles, silently
    // dropping the runtime externals (@lydell/node-pty, better-sqlite3, …).
    // Ship node_modules too; packager's prune keeps production deps only.
    ignore: (file: string) => {
      if (!file) return false;
      if (file === '/package.json') return false;
      if (file.startsWith('/.vite')) return false;
      if (file.startsWith('/node_modules')) return false;
      return true;
    },
    // Voice capture: macOS shows this string on the first mic-permission prompt.
    // The matching hardened-runtime entitlement (com.apple.security.device.microphone)
    // lives in build/entitlements.mac.plist and is applied when code signing is
    // configured (osxSign). Present here so an unsigned dev build still prompts.
    extendInfo: {
      CFBundleName: 'NexusIDE',
      CFBundleDisplayName: 'NexusIDE',
      NSMicrophoneUsageDescription:
        'NexusIDE uses the microphone for push-to-talk voice commands (Jarvis mode).',
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
    // Code signing always runs so extendInfo changes are bound into the app
    // signature. Without Apple credentials this is ad-hoc (`identity: '-'`):
    // good for local validation, still not distributable through Gatekeeper.
    // Notarization activates ONLY when the build machine exports the Apple
    // credentials (APPLE_TEAM_ID present).
    // Release builds must export: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
    // APPLE_TEAM_ID (see build/notarize.md).
    osxSign: {
      ...(process.env.APPLE_TEAM_ID ? {} : { identity: '-' }),
      // Hardened runtime is on by default in @electron/osx-sign; apply our
      // entitlements to every Mach-O it signs (app + nested natives).
      optionsForFile: () => ({
        entitlements: 'build/entitlements.mac.plist',
      }),
    },
    ...(process.env.APPLE_TEAM_ID
      ? {
          osxNotarize: {
            appleId: process.env.APPLE_ID as string,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD as string,
            teamId: process.env.APPLE_TEAM_ID as string,
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    // .dmg is the installable macOS artifact; ZIP doubles as the
    // Squirrel.Mac auto-update payload.
    // Code signing/notarization (osxSign/osxNotarize in packagerConfig)
    // activates when a Developer ID identity is present on the build machine.
    new MakerDMG({ format: 'ULFO', icon: 'assets/icon.icns' }, ['darwin']),
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        // PTY host: separate utilityProcess entry, built beside main.js as
        // .vite/build/pty-host-entry.js (docs/ARCHITECTURE.md §B.2).
        { entry: 'src/main/pty/pty-host-entry.ts', config: 'vite.pty-host.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // Hardening fuses: no Node in the renderer, no inspector, load app only
    // from the signed asar. This is the production security baseline.
    ...(process.env.NEXUS_SKIP_FUSES ? [] : [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
    ]),
  ],
};

export default config;
