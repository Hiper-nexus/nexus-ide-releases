import { describe, expect, it } from 'vitest';

import { validateBuildNodeVersion } from './check-build-node.mjs';

describe('release Node version contract', () => {
  it('accepts Node 22.12+ within the pinned major', () => {
    expect(validateBuildNodeVersion('22.12.0')).toBe(true);
    expect(validateBuildNodeVersion('22.22.3')).toBe(true);
  });

  it.each(['20.19.0', '22.11.0', '23.0.0', 'invalid'])(
    'rejects unsupported runtime %s',
    (version) => {
      expect(validateBuildNodeVersion(version)).toBe(false);
    },
  );
});
