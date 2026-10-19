import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const minimatch = require('minimatch') as (
  target: string,
  pattern: string,
  options?: { matchBase?: boolean },
) => boolean;

import forgeConfig, {
  assertRequiredWakeResource,
  createLinuxDebMakerConfig,
  createLinuxRpmMakerConfig,
  createWindowsInstallerBrandingConfig,
  createWindowsSignOptions,
  windowsTimestampServer,
} from './forge.config';
import { WINDOWS_SIGNER_HOOK_MODULE, WINDOWS_SIGNING_IDENTITY } from './build/windows-token-signing';

describe('Windows release signing', () => {
  const pinned = {
    ...WINDOWS_SIGNING_IDENTITY,
    certificateSha1: '0123456789ABCDEF0123456789ABCDEF01234567',
  };
  const yubikey = { NEXUS_WINDOWS_YUBIKEY_SIGNING: '1' };

  it('keeps signing disabled without the explicit YubiKey opt-in', () => {
    expect(createWindowsSignOptions({}, pinned)).toBeUndefined();
  });

  it('signs through the YubiKey agent hook, never a SignTool process per file', () => {
    const options = createWindowsSignOptions(yubikey, pinned);
    expect(options).toEqual({ continueOnError: false, hookModulePath: WINDOWS_SIGNER_HOOK_MODULE });
    // O Squirrel serializa as opções em JSON para o signtool falso: função não
    // sobrevive, e o caminho precisa valer fora da pasta do projeto.
    expect(JSON.parse(JSON.stringify(options))).toEqual(options);
    expect(path.isAbsolute(WINDOWS_SIGNER_HOOK_MODULE)).toBe(true);
    expect(existsSync(WINDOWS_SIGNER_HOOK_MODULE)).toBe(true);
  });

  it('carrega o hook como o @electron/windows-sign carrega (require do caminho, função exportada)', () => {
    const hook = require(path.resolve(WINDOWS_SIGNER_HOOK_MODULE)) as { default?: unknown };
    expect(hook.default).toBeUndefined();
    expect(typeof hook).toBe('function');
  });

  it('valida as horas do agente ao carregar a config', () => {
    expect(() => createWindowsSignOptions({ ...yubikey, NEXUS_WINDOWS_SIGNER_HOURS: '169' }, pinned))
      .toThrow(/NEXUS_WINDOWS_SIGNER_HOURS/u);
    expect(createWindowsSignOptions({ ...yubikey, NEXUS_WINDOWS_SIGNER_HOURS: '168' }, pinned))
      .toBeDefined();
  });

  it('refuses until the reissued certificate is pinned', () => {
    expect(() => createWindowsSignOptions(yubikey, { ...pinned, certificateSha1: null }))
      .toThrow(/No YubiKey certificate is pinned/u);
  });

  it('has no path back to the eSigner, a PFX or another store certificate', () => {
    for (const environment of [
      { NEXUS_WINDOWS_RELEASE_SIGNING: '1', WINDOWS_CERTIFICATE_SHA1: 'E44D98FF840B1DF78D87F6768D177B5719952CAB' },
      { NEXUS_WINDOWS_RELEASE_SIGNING: '1', WINDOWS_CERTIFICATE_FILE: 'publisher.pfx', WINDOWS_CERTIFICATE_PASSWORD: 'secret' },
      { ...yubikey, WINDOWS_CERTIFICATE_SHA1: '0123456789ABCDEF0123456789ABCDEF01234567' },
      { ...yubikey, WINDOWS_CERTIFICATE_FILE: 'publisher.pfx', WINDOWS_CERTIFICATE_PASSWORD: 'secret' },
      { ...yubikey, NEXUS_WINDOWS_RELEASE_SIGNING: '1' },
      { ...yubikey, WINDOWS_SIGN_HOOK_MODULE_PATH: 'evil.js' },
      { ...yubikey, NEXUS_WINDOWS_SIGNER_DIR: 'C:\\outro-agente' },
    ]) {
      expect(() => createWindowsSignOptions(environment, pinned)).toThrow();
    }
  });

  it('troca o servidor de carimbo só com uma URL explícita (F-656)', () => {
    expect(windowsTimestampServer({ NEXUS_WINDOWS_TIMESTAMP_URL: ' http://timestamp.sectigo.com ' }))
      .toBe('http://timestamp.sectigo.com');
    expect(windowsTimestampServer({ NEXUS_WINDOWS_TIMESTAMP_URL: '/tr evil' }))
      .toBe('http://timestamp.digicert.com');
    expect(windowsTimestampServer({})).toBe('http://timestamp.digicert.com');
  });

  it('imports only build/ files that a clean checkout has (build/* is ignored by default)', () => {
    const imported = new Set<string>();
    const visit = (file: string) => {
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/gu)) {
        const base = path.resolve(path.dirname(file), specifier);
        const target = path.extname(base) ? base : `${base}.ts`;
        const relative = path.relative(process.cwd(), target).replaceAll('\\', '/');
        if (!relative.startsWith('build/') || imported.has(relative)) continue;
        imported.add(relative);
        if (relative.endsWith('.ts')) visit(target);
      }
    };
    visit('forge.config.ts');
    expect([...imported]).toEqual(expect.arrayContaining([
      'build/windows-token-signing.ts',
      'build/windows-signing-identity.json',
    ]));
    // Sem `--no-index`, o git só acusa o que é ignorado E não rastreado.
    const ignored = spawnSync('git', ['check-ignore', ...imported], { encoding: 'utf8' });
    expect(ignored.stdout.trim()).toBe('');
    expect(ignored.status).toBe(1);
  });

  it('checks the certificate store before packaging or making only when the build signs', async () => {
    expect(process.env.NEXUS_WINDOWS_YUBIKEY_SIGNING).toBeUndefined();
    const resolved = forgeConfig as never;
    await expect(forgeConfig.hooks?.prePackage?.(resolved, 'win32', 'x64')).resolves.toBeUndefined();
    await expect(forgeConfig.hooks?.preMake?.(resolved)).resolves.toBeUndefined();
  });
});

describe('Windows installer branding', () => {
  it('uses the Nexus icon and branded loading artwork', () => {
    expect(createWindowsInstallerBrandingConfig()).toMatchObject({
      setupIcon: 'assets/icon.ico',
      iconUrl: 'https://raw.githubusercontent.com/Hiper-nexus/nexus-ide-releases/main/icon.ico',
      loadingGif: 'assets/installer-loading.gif',
    });
    expect(existsSync(path.resolve('assets/icon.ico'))).toBe(true);
    expect(existsSync(path.resolve('assets/installer-loading.gif'))).toBe(true);
    expect(forgeConfig.packagerConfig?.extraResource).toContain('assets/icon.ico');
  });
});

describe('macOS transport security', () => {
  it('keeps ATS enabled while allowing only local product services over HTTP', () => {
    const info = forgeConfig.packagerConfig?.extendInfo as Record<string, unknown>;

    expect(info.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    });
  });
});

describe('Linux sandbox packaging', () => {
  it('uses the executable name expected by the DEB and RPM makers', () => {
    expect(forgeConfig.packagerConfig?.executableName).toBe('nexus-ide');
  });

  it('declares Bubblewrap and the MIME index updater as runtime dependencies for DEB and RPM', () => {
    // desktop-file-utils: sem o índice atualizado na instalação o portal do
    // desktop não oferece o Nexus para nexus:// (F-740).
    expect(createLinuxDebMakerConfig().options?.depends).toEqual(['bubblewrap', 'desktop-file-utils']);
    // alsa-lib: o Electron liga libasound.so.2 direto; sem ela um Fedora enxuto não abre o app.
    expect(createLinuxRpmMakerConfig().options?.requires).toEqual(['bubblewrap', 'desktop-file-utils', 'alsa-lib']);
  });

  it('ships the brand icon instead of the installer default Electron icon', () => {
    for (const config of [createLinuxDebMakerConfig(), createLinuxRpmMakerConfig()]) {
      expect(config.options?.icon).toBe('assets/icon.png');
      expect(existsSync(path.resolve(process.cwd(), String(config.options?.icon)))).toBe(true);
    }
  });

  it('registers the nexus:// login deep link in the installed desktop entry', () => {
    for (const config of [createLinuxDebMakerConfig(), createLinuxRpmMakerConfig()]) {
      expect(config.options?.mimeType).toEqual(['x-scheme-handler/nexus']);
      expect(config.options?.categories).toEqual(['Development']);
      expect(config.options?.homepage).toBe('https://nexuside.app');
    }
    expect(createLinuxDebMakerConfig().options?.section).toBe('devel');
  });

  it('ships the runtime icon resource only in the Linux package', () => {
    const resources = forgeConfig.packagerConfig?.extraResource ?? [];
    expect(resources.includes('assets/icon.png')).toBe(process.platform === 'linux');
  });
});

describe('platform-specific maker matrix', () => {
  it('keeps each distributable maker on its native operating system', () => {
    expect(
      forgeConfig.makers?.map((maker) => ({
        name: maker.name,
        platforms: maker.platforms,
      })),
    ).toEqual([
      { name: 'dmg', platforms: ['darwin'] },
      { name: 'squirrel', platforms: ['win32'] },
      { name: 'zip', platforms: ['darwin', 'linux'] },
      { name: 'rpm', platforms: ['linux'] },
      { name: 'deb', platforms: ['linux'] },
    ]);
  });
});

describe('native terminal packaging', () => {
  it('F-1296: *.so and *.so.* do not unpack TypeScript sources named *.source.ts', () => {
    const unpack = (forgeConfig.packagerConfig?.asar as { unpack?: string }).unpack ?? '';
    expect(
      minimatch(
        'node_modules/zod/src/v3/tests/language-server.source.ts',
        unpack,
        { matchBase: true },
      ),
    ).toBe(false);
    expect(minimatch('libfoo.so', unpack, { matchBase: true })).toBe(true);
    expect(minimatch('libfoo.so.1', unpack, { matchBase: true })).toBe(true);
  });

  it('unpacks Windows DLLs used beside native Node bindings', () => {
    expect(
      (forgeConfig.packagerConfig?.asar as { unpack?: string }).unpack,
    ).toContain('*.dll');
  });

  it('unpacks complete node-pty packages without naming a mutable spawn-helper', () => {
    expect(forgeConfig.packagerConfig?.asar).toMatchObject({
      unpackDir: '**/node_modules/@lydell/{node-pty,node-pty-*}',
    });
    expect(
      (forgeConfig.packagerConfig?.asar as { unpack?: string }).unpack,
    ).not.toContain('spawn-helper');
  });

  it('ships the signed responsibility supervisor on Darwin build hosts', () => {
    const resources = forgeConfig.packagerConfig?.extraResource;
    if (process.platform === 'darwin') {
      expect(resources).toContain(
        'resources/native/darwin/nexus-pty-supervisor',
      );
    } else {
      expect(resources).not.toContain(
        'resources/native/darwin/nexus-pty-supervisor',
      );
    }
  });

  it('ships the Redline tray companion on Windows build hosts only', () => {
    const resources = forgeConfig.packagerConfig?.extraResource;
    if (process.platform === 'win32') {
      expect(resources).toContain('resources/native/win32/nexus-redline');
    } else {
      expect(resources).not.toContain('resources/native/win32/nexus-redline');
    }
  });

  it('ships the Redline menu bar companion on Darwin build hosts only', () => {
    const resources = forgeConfig.packagerConfig?.extraResource;
    if (process.platform === 'darwin') {
      expect(resources).toContain('resources/native/darwin/nexus-redline');
    } else {
      expect(resources).not.toContain('resources/native/darwin/nexus-redline');
    }
  });
});

describe('required PT-BR wake model packaging', () => {
  it('ships the wake resource directory on every Forge target', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toContain('resources/wake');
  });

  it('validates the pinned source resource before release completion', () => {
    expect(() => assertRequiredWakeResource(path.resolve('resources'))).not.toThrow();
  });
});

describe('mission shim packaging', () => {
  it('ships the private nx command client on every Forge target', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toContain(
      'resources/mission-shims',
    );
  });
});

describe('squad presets resources packaging', () => {
  it('ships the squad resource directories on every Forge target', () => {
    const extra = forgeConfig.packagerConfig?.extraResource ?? [];
    expect(extra).toContain('resources/qa-swarm');
    expect(extra).toContain('resources/qa-vision');
    expect(extra).toContain('resources/absurd-landing');
    expect(extra).toContain('resources/cinema-site');
    expect(extra).toContain('resources/squad-former');
  });
});

describe('agent detection manifests packaging', () => {
  it('ships the Herdr agent-detection manifests on every Forge target', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toContain(
      'resources/agent-detection',
    );
  });

  it('ships the libghostty-vt grid outside the asar on every Forge target', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toContain('resources/ghostty');
  });
});

