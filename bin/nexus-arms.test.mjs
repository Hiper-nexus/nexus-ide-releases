import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  callerPaneIdOf,
  isPaneHome,
  paneHomeDescriptor,
  resolveDescriptorPath,
  sessionUrl,
} from './nexus-arms.mjs';

const home = path.resolve('/tmp/nexus-arms-home');
const defaultDescriptor = path.join(home, '.nexus', 'arms-runtime.json');
const envDescriptor = path.resolve('/tmp/nexus-arms-env.json');
const argvDescriptor = path.resolve('/tmp/nexus-arms-argv.json');

const PANE_ENV = {
  NEXUS_PANE_ID: 'pane-10029',
  NEXUS_ARMS_DESCRIPTOR: defaultDescriptor,
  NEXUS_PANE_ARMS_DESCRIPTOR: defaultDescriptor,
};

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

  it('OVKA-529: a casa do pane vence o env herdado', () => {
    // mesmo com NEXUS_ARMS_DESCRIPTOR apontando para a casa, é a casa que resolve
    expect(resolveDescriptorPath(['node'], PANE_ENV, home)).toBe(defaultDescriptor);
  });
});

describe('OVKA-529 — identidade de pane', () => {
  it('isPaneHome requires id + home + undeviated target', () => {
    expect(isPaneHome(PANE_ENV)).toBe(true);
    expect(isPaneHome({ NEXUS_ARMS_DESCRIPTOR: defaultDescriptor })).toBe(false);
    expect(isPaneHome({})).toBe(false);
    expect(
      isPaneHome({ ...PANE_ENV, NEXUS_ARMS_DESCRIPTOR: '/x/other.json' }),
    ).toBe(false);
    expect(paneHomeDescriptor(PANE_ENV)).toBe(defaultDescriptor);
  });

  it('callerPaneIdOf only at home; foreign descriptor drops identity', () => {
    expect(callerPaneIdOf(PANE_ENV)).toBe('pane-10029');
    expect(
      callerPaneIdOf({ ...PANE_ENV, NEXUS_ARMS_DESCRIPTOR: '/x/other.json' }),
    ).toBeNull();
    expect(callerPaneIdOf({ ...PANE_ENV, NEXUS_PANE_ID: '   ' })).toBeNull();
  });

  it('sessionUrl declares callerPaneId at home and stays anonymous outside', () => {
    const url = sessionUrl('http://127.0.0.1:9/arms/mcp', PANE_ENV);
    expect(url).toContain('callerPaneId=pane-10029');
    expect(sessionUrl('http://127.0.0.1:9/arms/mcp', {})).toBe(
      'http://127.0.0.1:9/arms/mcp',
    );
    expect(
      sessionUrl('http://127.0.0.1:9/arms/mcp', {
        ...PANE_ENV,
        NEXUS_ARMS_DESCRIPTOR: '/x/other.json',
      }),
    ).toBe('http://127.0.0.1:9/arms/mcp');
  });
});
