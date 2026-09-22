/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionRelaySection } from './CompanionRelaySection';
import { RemoteSection } from './CatalogSectionsOps';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const bridgeInfo = {
  running: true,
  pairingCode: '123456',
  tokenCount: 1,
  clientCount: 0,
  urls: ['wss://192.168.0.5:7777'],
  certFingerprint: 'AA:BB',
};

function mount(node: ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Celular na rede local', () => {
  let remote: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    remote = {
      bridgeStatus: vi.fn(async () => bridgeInfo),
      bridgeStart: vi.fn(async () => bridgeInfo),
      bridgeRotatePairing: vi.fn(async () => ({ ...bridgeInfo, pairingCode: '654321' })),
      bridgeRevokeTokens: vi.fn(async () => bridgeInfo),
      listSshHosts: vi.fn(async () => []),
      connectSshHost: vi.fn(),
      importSshConfig: vi.fn(),
      removeSshHost: vi.fn(),
    };
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { remote },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('vive na página Celular, com código, QR e ações do bridge', async () => {
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    const card = host.querySelector('[aria-labelledby="remote-bridge-title"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Celular na rede local');
    expect(card!.textContent).toContain('123456');
    expect(card!.textContent).toContain('Abra no celular: https://192.168.0.5:7777');
    expect(remote.bridgeStatus).toHaveBeenCalledTimes(1);

    const newCode = [...card!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Novo código',
    )!;
    await act(async () => newCode.click());
    expect(remote.bridgeRotatePairing).toHaveBeenCalledTimes(1);
    expect(card!.textContent).toContain('654321');

    act(() => root.unmount());
  });

  it('não aparece mais em Máquinas remotas', async () => {
    const { host, root } = mount(<RemoteSection />);
    await flush();

    expect(host.querySelector('#remote-bridge-title')).toBeNull();
    expect(host.textContent).not.toContain('Celular na rede local');
    expect(remote.bridgeStatus).not.toHaveBeenCalled();
    expect(host.querySelector('#remote-ssh-title')).not.toBeNull();

    act(() => root.unmount());
  });
});
