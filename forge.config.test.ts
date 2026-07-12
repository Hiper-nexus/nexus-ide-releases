import { describe, expect, it } from 'vitest';

import forgeConfig, {
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
  it('unpacks complete node-pty packages, including helpers and conpty bindings', () => {
    expect(forgeConfig.packagerConfig?.asar).toMatchObject({
      unpackDir: '**/node_modules/@lydell/{node-pty,node-pty-*}',
    });
  });
});
