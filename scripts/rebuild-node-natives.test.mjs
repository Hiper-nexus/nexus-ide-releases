import { describe, expect, it } from 'vitest';

import { sanitizeBuildEnvironment } from './rebuild-node-natives.mjs';

describe('native rebuild environment', () => {
  it('removes credentials while preserving the build toolchain environment', () => {
    const sanitized = sanitizeBuildEnvironment({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      SDKROOT: '/tmp/sdk',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      LICENSE_PRIVATE_KEY: 'secret',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    });

    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      SDKROOT: '/tmp/sdk',
    });
  });
});
