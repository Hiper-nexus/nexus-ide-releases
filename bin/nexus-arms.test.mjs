import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDescriptorPath } from './nexus-arms.mjs';

const home = path.resolve('/tmp/nexus-arms-home');
const defaultDescriptor = path.join(home, '.nexus', 'arms-runtime.json');
const envDescriptor = path.resolve('/tmp/nexus-arms-env.json');
const argvDescriptor = path.resolve('/tmp/nexus-arms-argv.json');

describe('resolveDescriptorPath', () => {
  it('prefers argv over env over the default descriptor', () => {
    expect(
      resolveDescriptorPath(
        ['node', 'bin/nexus-arms.mjs', '--descriptor', argvDescriptor],
        { NEXUS_ARMS_DESCRIPTOR: envDescriptor },
        home,
      ),
    ).toBe(argvDescriptor);

    expect(
      resolveDescriptorPath(
        ['node', 'bin/nexus-arms.mjs'],
        { NEXUS_ARMS_DESCRIPTOR: envDescriptor },
        home,
      ),
    ).toBe(envDescriptor);

    expect(resolveDescriptorPath(['node', 'bin/nexus-arms.mjs'], {}, home)).toBe(
      defaultDescriptor,
    );
  });

  it('rejects relative descriptor paths explicitly', () => {
    expect(() =>
      resolveDescriptorPath(
        ['node', 'bin/nexus-arms.mjs', '--descriptor', 'relative.json'],
        {},
        home,
      ),
    ).toThrow(/absoluto/i);

    expect(() =>
      resolveDescriptorPath(
        ['node', 'bin/nexus-arms.mjs'],
        { NEXUS_ARMS_DESCRIPTOR: 'relative.json' },
        home,
      ),
    ).toThrow(/absoluto/i);
  });

  it('falls back safely when --descriptor has no value', () => {
    expect(
      resolveDescriptorPath(
        ['node', 'bin/nexus-arms.mjs', '--descriptor'],
        { NEXUS_ARMS_DESCRIPTOR: envDescriptor },
        home,
      ),
    ).toBe(envDescriptor);
  });
});
