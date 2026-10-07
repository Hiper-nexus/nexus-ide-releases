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

  it('toggle do tailnet nasce ligado com a CLI logada e só age no start', async () => {
    const detected = {
      ...bridgeInfo,
      running: false,
      urls: [],
      tailscale: { magicDnsName: 'box.tail1234.ts.net', status: 'requires-configuration' },
    };
    const published = {
      ...bridgeInfo,
      urls: ['wss://box.tail1234.ts.net', 'wss://127.0.0.1:7777'],
      endpoints: [
        { url: 'wss://box.tail1234.ts.net', label: 'Tailscale HTTPS' },
        { url: 'wss://127.0.0.1:7777', label: 'Este computador' },
      ],
      tailscale: {
        magicDnsName: 'box.tail1234.ts.net',
        httpsUrl: 'https://box.tail1234.ts.net/',
        status: 'available',
      },
    };
    remote.bridgeStatus.mockResolvedValueOnce(detected);
    remote.bridgeStart.mockResolvedValue(published);
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      'input[aria-label="Publicar no tailnet (HTTPS)"]',
    )!;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    // Mostrar o toggle não publica nada: só o clique em Iniciar age.
    expect(remote.bridgeStart).not.toHaveBeenCalled();

    const startHere = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Iniciar neste computador',
    )!;
    await act(async () => startHere.click());
    expect(remote.bridgeStart).toHaveBeenLastCalledWith({ tailscale: true });
    const card = host.querySelector('[aria-labelledby="remote-bridge-title"]')!;
    expect(card.textContent).toContain('Abra no celular: https://box.tail1234.ts.net/');
    expect(card.textContent).toContain('Tailscale HTTPS: wss://box.tail1234.ts.net');

    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    const startLan = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Iniciar na rede local',
    )!;
    await act(async () => startLan.click());
    expect(remote.bridgeStart).toHaveBeenLastCalledWith({ host: '0.0.0.0', tailscale: false });

    act(() => root.unmount());
  });

  it('toggle do tailnet fica desligado e explica quando o Tailscale falta', async () => {
    remote.bridgeStatus.mockResolvedValueOnce({
      ...bridgeInfo,
      tailscale: { magicDnsName: null, status: 'unavailable', diagnostic: 'not-installed' },
    });
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    const toggle = host.querySelector<HTMLInputElement>(
      'input[aria-label="Publicar no tailnet (HTTPS)"]',
    )!;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(host.textContent).toContain('Tailscale não encontrado neste computador');

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
