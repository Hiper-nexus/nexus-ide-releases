/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/update-ipc';
import { resetOverlayRootForTest } from '../overlay/overlay-layer';
import { UpdateBannerNotice, UpdateModal } from './UpdateModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function mount(node: React.ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

describe('UpdateModal', () => {
  const mockInstall = vi.fn().mockResolvedValue(undefined);
  const mockRestart = vi.fn().mockResolvedValue(undefined);
  const mockCheck = vi.fn().mockResolvedValue(undefined);
  const mockOpenExternal = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    vi.clearAllMocks();
    resetOverlayRootForTest();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        update: {
          install: mockInstall,
          restart: mockRestart,
          check: mockCheck,
        },
        app: {
          openExternal: mockOpenExternal,
        },
      },
    });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const entry = mountedRoots.pop();
      if (!entry) break;
      act(() => entry.root.unmount());
      entry.host.remove();
    }
    resetOverlayRootForTest();
    document.body.innerHTML = '';
  });

  it('renders available update with install button', () => {
    const state: UpdateState = {
      phase: 'available',
      currentVersion: '0.76.18',
      source: 'gh',
      canInstall: true,
      available: {
        version: '0.76.19',
        tag: 'v0.76.19',
        notes: 'Changelog notes',
      },
    };

    mount(<UpdateModal state={state} onClose={vi.fn()} />);

    expect(document.body.textContent).toContain('ATUALIZAÇÃO');
    expect(document.body.textContent).toContain('0.76.18');
    expect(document.body.textContent).toContain('0.76.19');
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const installBtn = buttons.find((b) => b.textContent?.includes('Baixar e instalar'));
    expect(installBtn).toBeDefined();
  });

  it('renders error state with fallback DMG download and retry buttons', () => {
    const state: UpdateState = {
      phase: 'error',
      currentVersion: '0.76.18',
      source: 'gh',
      canInstall: true,
      error: 'O app atual foi aberto fora de /Applications ou a partir de build sem assinatura Developer ID. Instale o .dmg oficial para atualizar.',
      available: {
        version: '0.76.19',
        tag: 'v0.76.19',
      },
    };

    mount(<UpdateModal state={state} onClose={vi.fn()} />);

    expect(document.body.textContent).toContain('O app atual foi aberto fora de /Applications');

    const buttons = Array.from(document.body.querySelectorAll('button'));
    const dmgBtn = buttons.find((b) => b.textContent?.includes('Baixar instalador (.dmg)'));
    expect(dmgBtn).toBeDefined();
    act(() => {
      dmgBtn?.click();
    });
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://github.com/Hiper-nexus/nexus-ide/releases/tag/v0.76.19',
    );

    const retryBtn = buttons.find((b) => b.textContent?.includes('Tentar novamente'));
    expect(retryBtn).toBeDefined();
    act(() => {
      retryBtn?.click();
    });
    expect(mockInstall).toHaveBeenCalled();
  });
});

describe('UpdateBannerNotice', () => {
  const mockInstall = vi.fn().mockResolvedValue(undefined);
  const mockRestart = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        update: {
          install: mockInstall,
          restart: mockRestart,
        },
      },
    });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const entry = mountedRoots.pop();
      if (!entry) break;
      act(() => entry.root.unmount());
      entry.host.remove();
    }
    document.body.innerHTML = '';
  });

  it('renders prominent banner when update is available and executes install on click', () => {
    const state: UpdateState = {
      phase: 'available',
      currentVersion: '0.76.21',
      source: 'gh',
      canInstall: true,
      available: {
        version: '0.76.22',
        tag: 'v0.76.22',
      },
    };
    const onOpenModal = vi.fn();

    mount(<UpdateBannerNotice state={state} onOpenModal={onOpenModal} />);

    expect(document.body.textContent).toContain('Nova versão disponível: v0.76.22');
    const installBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Atualizar agora'),
    );
    expect(installBtn).toBeDefined();
    act(() => {
      installBtn?.click();
    });
    expect(mockInstall).toHaveBeenCalled();
  });

  it('renders restart button when update is ready and dismisses on close', () => {
    const state: UpdateState = {
      phase: 'ready',
      currentVersion: '0.76.21',
      source: 'gh',
      canInstall: true,
      available: {
        version: '0.76.22',
        tag: 'v0.76.22',
      },
    };

    mount(<UpdateBannerNotice state={state} onOpenModal={vi.fn()} />);

    expect(document.body.textContent).toContain('Atualização pronta para aplicar!');
    const restartBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reiniciar agora'),
    );
    expect(restartBtn).toBeDefined();
    act(() => {
      restartBtn?.click();
    });
    expect(mockRestart).toHaveBeenCalled();

    const closeBtn = document.body.querySelector('.update-banner__close') as HTMLButtonElement;
    expect(closeBtn).toBeDefined();
    act(() => {
      closeBtn?.click();
    });
    expect(document.body.querySelector('.update-banner')).toBeNull();
  });
});
