import { describe, expect, it } from 'vitest';
import path from 'node:path';

import forgeConfig, {
  assertRequiredWakeResource,
  createLinuxDebMakerConfig,
  createLinuxRpmMakerConfig,
} from './forge.config';

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

  it('declares Bubblewrap as a runtime dependency for DEB and RPM installs', () => {
    expect(createLinuxDebMakerConfig()).toEqual({
      options: { depends: ['bubblewrap'] },
    });
    expect(createLinuxRpmMakerConfig()).toEqual({
      options: { requires: ['bubblewrap'] },
    });
  });
});

describe('native terminal packaging', () => {
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
});

describe('required PT-BR wake model packaging', () => {
  it('ships the wake resource directory on every Forge target', () => {
    expect(forgeConfig.packagerConfig?.extraResource).toContain('resources/wake');
  });

  it('validates the pinned source resource before release completion', () => {
    expect(() => assertRequiredWakeResource(path.resolve('resources'))).not.toThrow();
  });
});
