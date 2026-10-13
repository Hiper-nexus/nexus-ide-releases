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
      bridgeSetDeviceScopes: vi.fn(async () => bridgeInfo),
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

  it('MOB-12: escolhe os escopos do próximo código e edita os de um aparelho pareado', async () => {
    const device = {
      id: 'grant-1',
      keyFingerprint: 'abcdef0123456789'.repeat(4),
      pairedAt: Date.UTC(2026, 9, 8, 12),
      expiresAt: Date.UTC(2026, 9, 15, 12),
      scopes: ['read', 'input', 'approve', 'close'],
      connected: true,
    };
    remote.bridgeStatus.mockResolvedValueOnce({
      ...bridgeInfo,
      pairingScopes: ['read', 'input', 'approve', 'close'],
      devices: [device],
    });
    remote.bridgeRotatePairing.mockResolvedValueOnce({
      ...bridgeInfo,
      pairingCode: '777777',
      pairingScopes: ['read', 'approve'],
      devices: [device],
    });
    remote.bridgeSetDeviceScopes.mockResolvedValueOnce({
      ...bridgeInfo,
      devices: [{ ...device, scopes: ['read', 'approve', 'close'] }],
    });
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();
    const card = host.querySelector('[aria-labelledby="remote-bridge-title"]')!;
    expect(card.textContent).toContain('Ver · Enviar comandos · Aprovar · Fechar panes');
    expect(card.textContent).toContain('Aparelho abcd ef01 2345');
    expect(card.textContent).toContain('conectado');

    const input = (label: string) =>
      host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    // Próximo código só com Ver + Aprovar.
    await act(async () => input('Permissões do próximo aparelho: Enviar comandos').click());
    await act(async () => input('Permissões do próximo aparelho: Fechar panes').click());
    const newCode = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Novo código',
    )!;
    await act(async () => newCode.click());
    expect(remote.bridgeRotatePairing).toHaveBeenLastCalledWith({ scopes: ['read', 'approve'] });
    expect(card.textContent).toContain('777777');
    expect(card.textContent).toContain('Ver · Aprovar');

    // Aparelho já pareado: tirar "Enviar comandos" vale no próximo pedido dele.
    const deviceInput = input('Permissões do aparelho abcd ef01 2345: Enviar comandos');
    expect(deviceInput.checked).toBe(true);
    await act(async () => deviceInput.click());
    expect(remote.bridgeSetDeviceScopes).toHaveBeenCalledWith({
      deviceId: 'grant-1',
      scopes: ['read', 'approve', 'close'],
    });
    expect(input('Permissões do aparelho abcd ef01 2345: Enviar comandos').checked).toBe(false);

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

describe('Acesso pelo celular (relay)', () => {
  const ROOM_LINK = 'wss://relay.nexuside.app/r/0123456789abcdef0123456789abcdef';
  const fullLink = `${ROOM_LINK}#${'A'.repeat(64)}`;
  const viewLink = `${ROOM_LINK}#${'A'.repeat(43)}`;
  const fullWebUrl = `https://app.nexuside.app/#${encodeURIComponent(fullLink)}`;
  const viewWebUrl = `https://app.nexuside.app/#${encodeURIComponent(viewLink)}`;
  const paired = {
    running: true,
    connected: true,
    relayUrl: 'wss://relay.nexuside.app',
    roomId: '0123456789abcdef0123456789abcdef',
    fullLink,
    viewLink,
    fullWebUrl,
    viewWebUrl,
    qrSvgFull: '<svg></svg>',
    qrSvgView: '<svg></svg>',
    guestCount: 0,
  };
  let relay: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    relay = {
      status: vi.fn(async () => paired),
      start: vi.fn(async () => paired),
      stop: vi.fn(async () => ({ running: false, connected: false, guestCount: 0 })),
    };
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        remote: { bridgeStatus: vi.fn(async () => bridgeInfo), relay },
        product: {
          flagsList: vi.fn(async () => [
            { id: 'feature.remote.relayTransport', enabled: true },
          ]),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const fullQr = (host: HTMLElement) =>
    host.querySelector('img[alt="QR do link full (controle da sessão)"]');

  it('F-1472: sem conexão com o relay não mostra QR e diz que está tentando de novo, com o motivo', async () => {
    relay.status.mockResolvedValue({
      ...paired,
      connected: false,
      lastError: 'Unexpected server response: 404',
    });
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    expect(fullQr(host)).toBeNull();
    expect(host.textContent).toContain(
      'Servidor de conexão indisponível — tentando de novo',
    );
    expect(host.textContent).toContain('Unexpected server response: 404');
    expect(host.querySelector('input[aria-label="Link full (link de pareamento)"]')).toBeNull();

    act(() => root.unmount());
  });

  it('F-1472: conectado mostra o QR e as caixas mostram/copiam a URL https do QR, não o wss', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    expect(fullQr(host)).not.toBeNull();
    const fullInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="Link full (link de pareamento)"]',
    )!;
    const viewInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="Link view (link de pareamento)"]',
    )!;
    expect(fullInput.value).toBe(fullWebUrl);
    expect(viewInput.value).toBe(viewWebUrl);

    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="Copiar Link full"]')!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(fullWebUrl);
    expect(writeText.mock.calls[0]![0]).not.toMatch(/^wss:/);

    act(() => root.unmount());
  });

  it('F-1472: o poll de 4 s troca o QR por "Gerar novo QR" quando o relay encerra a sala', async () => {
    vi.useFakeTimers();
    try {
      const { host, root } = mount(<CompanionRelaySection />);
      await flush();
      expect(fullQr(host)).not.toBeNull();

      // Estado que o CompanionRelayHost publica depois do TTL do server.ts (4001).
      relay.status.mockResolvedValue({
        running: true,
        connected: false,
        relayUrl: 'wss://relay.nexuside.app',
        guestCount: 0,
        lastError: 'room closed',
      });
      await act(async () => {
        vi.advanceTimersByTime(4_000);
      });
      await flush();

      expect(fullQr(host)).toBeNull();
      expect(host.textContent).toContain('A sala do celular foi encerrada (room closed)');
      expect(
        [...host.querySelectorAll('button')].some((button) => button.textContent === 'Gerar novo QR'),
      ).toBe(true);
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-1472: sala encerrada (sem QR válido) oferece "Gerar novo QR", que reinicia pela rota de Parar/Iniciar', async () => {
    relay.status.mockResolvedValue({
      running: true,
      connected: false,
      relayUrl: 'wss://relay.nexuside.app',
      guestCount: 0,
      lastError: 'room closed',
    });
    const { host, root } = mount(<CompanionRelaySection />);
    await flush();

    expect(fullQr(host)).toBeNull();
    const regenerate = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Gerar novo QR',
    );
    expect(regenerate).toBeDefined();
    await act(async () => regenerate!.click());
    await flush();
    expect(relay.stop).toHaveBeenCalledTimes(1);
    expect(relay.start).toHaveBeenCalledWith({ relayUrl: 'wss://relay.nexuside.app' });
    expect(relay.stop.mock.invocationCallOrder[0]).toBeLessThan(
      relay.start.mock.invocationCallOrder[0]!,
    );
    expect(fullQr(host)).not.toBeNull();

    act(() => root.unmount());
  });
});
