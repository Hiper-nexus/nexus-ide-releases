import { describe, expect, it } from 'vitest';
import {
  callerPaneIdOf,
  isPaneHome,
  paneHomeDescriptor,
  paneTransportRefusalMessage,
  resolveDescriptorTarget,
  sessionUrl,
} from './pane-identity';

const HOME = '/home/u/.nexus/arms-runtime.json';
const PANE_ENV = {
  NEXUS_PANE_ID: 'pane-10029',
  NEXUS_ARMS_DESCRIPTOR: HOME,
  NEXUS_PANE_ARMS_DESCRIPTOR: HOME,
};

describe('pane identity — a casa do pane vence a conexão herdada', () => {
  it('isPaneHome requires id + home + undeviated target', () => {
    expect(isPaneHome(PANE_ENV)).toBe(true);
    expect(isPaneHome({ NEXUS_ARMS_DESCRIPTOR: HOME })).toBe(false);
    expect(isPaneHome({})).toBe(false);
    expect(
      isPaneHome({ ...PANE_ENV, NEXUS_ARMS_DESCRIPTOR: '/x/other.json' }),
    ).toBe(false);
    expect(paneHomeDescriptor(PANE_ENV)).toBe(HOME);
  });

  it('--descriptor to another instance drops pane identity', () => {
    const target = resolveDescriptorTarget(
      ['node', 'nexus-arms.mjs', '--descriptor', '/x/other.json'],
      PANE_ENV,
      '/default.json',
    );
    expect(target).toBe('/x/other.json');
    expect(callerPaneIdOf({ ...PANE_ENV, NEXUS_ARMS_DESCRIPTOR: '/x/other.json' })).toBeNull();
  });

  it('--descriptor to the same home keeps identity', () => {
    expect(callerPaneIdOf(PANE_ENV)).toBe('pane-10029');
  });

  it('home wins over inherited env target when still a pane at home', () => {
    // env aponta para outro lugar mas a casa bate com o alvo atual → em casa
    const atHome = {
      ...PANE_ENV,
      NEXUS_ARMS_DESCRIPTOR: HOME,
      NEXUS_PANE_ARMS_DESCRIPTOR: HOME,
    };
    expect(resolveDescriptorTarget(['node'], atHome, '/default.json')).toBe(HOME);
  });

  it('outside a pane the env target still applies', () => {
    expect(
      resolveDescriptorTarget(
        ['node'],
        { NEXUS_ARMS_DESCRIPTOR: '/env.json' },
        '/default.json',
      ),
    ).toBe('/env.json');
  });
});

describe('sessionUrl', () => {
  it('declares callerPaneId at home so budget/role apply', () => {
    const url = sessionUrl('http://127.0.0.1:9/mcp', PANE_ENV);
    expect(url).toContain('callerPaneId=pane-10029');
  });

  it('stays anonymous outside a pane (external connector)', () => {
    expect(sessionUrl('http://127.0.0.1:9/mcp', {})).toBe('http://127.0.0.1:9/mcp');
  });

  it('drops identity when the pane is operating a foreign instance', () => {
    const away = { ...PANE_ENV, NEXUS_ARMS_DESCRIPTOR: '/x/other.json' };
    expect(sessionUrl('http://127.0.0.1:9/mcp', away)).toBe('http://127.0.0.1:9/mcp');
  });

  it('preserves an existing query', () => {
    const url = sessionUrl('http://127.0.0.1:9/mcp?client=grok', PANE_ENV);
    expect(url).toContain('client=grok');
    expect(url).toContain('callerPaneId=pane-10029');
  });

  it('blank pane id is not identity', () => {
    expect(callerPaneIdOf({ ...PANE_ENV, NEXUS_PANE_ID: '   ' })).toBeNull();
    expect(callerPaneIdOf({ ...PANE_ENV, NEXUS_PANE_ID: ' pane-7 ' })).toBe('pane-7');
  });
});

describe('paneTransportRefusalMessage (OVKA-543)', () => {
  it('explains the pane initialize 406 without leaking untrusted body', () => {
    const message = paneTransportRefusalMessage(406, 'initialize', {
      isPane: true,
      untrustedBody: 'untrusted response body',
    });
    expect(message).toContain('406');
    expect(message).toContain('conexão nexus');
    expect(message).not.toContain('untrusted');
  });

  it('does not claim a pane restriction for an external connector', () => {
    expect(paneTransportRefusalMessage(406, 'initialize', { isPane: false })).toBe(
      'Nexus respondeu HTTP 406 para initialize.',
    );
  });

  it('does not mislabel other statuses', () => {
    expect(paneTransportRefusalMessage(403, 'initialize', { isPane: true })).toContain('403');
  });
});
