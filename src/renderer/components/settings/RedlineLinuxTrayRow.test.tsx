/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RedlineInstallStatus } from '../../../shared/redline-types';
import { useToastStore } from '../../state/toast-store';
import { RedlineLinuxTrayRow } from './RedlineLinuxTrayRow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function linuxStatus(
  tray: NonNullable<RedlineInstallStatus['inAppTray']>,
): RedlineInstallStatus {
  return { platform: 'linux', bundled: true, running: tray.state === 'running', inAppTray: tray };
}

describe('RedlineLinuxTrayRow', () => {
  let host: HTMLElement;
  let root: Root;
  let install: ReturnType<typeof vi.fn>;
  let hide: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let onChange: Mock<(status: RedlineInstallStatus) => void>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    install = vi.fn(async () => ({ ok: true, message: 'ligado' }));
    hide = vi.fn(async () => ({ ok: true, message: 'oculto' }));
    status = vi.fn(async () => linuxStatus({ enabled: true, state: 'running' }));
    onChange = vi.fn<(status: RedlineInstallStatus) => void>();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { redline: { status, install, hide, open: vi.fn() } },
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(initial: RedlineInstallStatus): void {
    act(() => {
      root.render(<RedlineLinuxTrayRow status={initial} onChange={onChange} />);
    });
  }

  const button = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes(label),
    );

  async function press(label: string): Promise<void> {
    const target = button(label);
    expect(target, `botão "${label}"`).toBeDefined();
    await act(async () => {
      target?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('off: says plainly that the Redline lives in the tray while NexusIDE is open', () => {
    render(linuxStatus({ enabled: false, state: 'off' }));
    const text = host.textContent ?? '';
    expect(text).toContain('Bandeja do sistema');
    expect(text).toMatch(/dentro do NexusIDE/);
    expect(text).toMatch(/enquanto o app estiver aberto/);
    expect(button('Mostrar na bandeja')).toBeDefined();
    expect(button('Ocultar da bandeja')).toBeUndefined();
  });

  it('never uses the Mac or Windows wording', () => {
    for (const tray of [
      { enabled: false, state: 'off' },
      { enabled: true, state: 'running' },
      { enabled: true, state: 'unavailable', reason: 'sem host' },
    ] as const) {
      render(linuxStatus(tray));
      const text = host.textContent ?? '';
      expect(text).not.toMatch(/barra do menu|topo do Mac|\/Applications|Instalar|admin/i);
    }
  });

  it('off: the main button enables the tray and refreshes the status', async () => {
    render(linuxStatus({ enabled: false, state: 'off' }));
    await press('Mostrar na bandeja');
    expect(install).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(linuxStatus({ enabled: true, state: 'running' }));
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toBe('Nexus Redline');
    expect(toast?.kind).toBe('success');
  });

  it('running: says it is in the tray and offers to hide it', async () => {
    render(linuxStatus({ enabled: true, state: 'running' }));
    expect(host.textContent).toMatch(/está na bandeja do sistema/);
    expect(button('Mostrar na bandeja')).toBeUndefined();
    status.mockResolvedValueOnce(linuxStatus({ enabled: false, state: 'off' }));
    await press('Ocultar da bandeja');
    expect(hide).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(linuxStatus({ enabled: false, state: 'off' }));
  });

  it('gives the honest fallback hints for desktops without a tray host', () => {
    render(linuxStatus({ enabled: false, state: 'off' }));
    expect(host.textContent).toMatch(/GNOME/);
    expect(host.textContent).toMatch(/AppIndicator/);
  });

  it('unavailable: shows the reason and offers retry or turning it off', async () => {
    render(
      linuxStatus({
        enabled: true,
        state: 'unavailable',
        reason: 'Não consegui criar o ícone na bandeja (sem host).',
      }),
    );
    expect(host.textContent).toContain('Não consegui criar o ícone na bandeja (sem host).');
    expect(button('Tentar de novo')).toBeDefined();
    expect(button('Desligar')).toBeDefined();
    await press('Tentar de novo');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('a refused enable shows a warning toast with the message', async () => {
    install.mockResolvedValueOnce({ ok: false, message: 'Não consegui criar o ícone na bandeja (x).' });
    status.mockResolvedValueOnce(linuxStatus({ enabled: false, state: 'off' }));
    render(linuxStatus({ enabled: false, state: 'off' }));
    await press('Mostrar na bandeja');
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe('warn');
    expect(JSON.stringify(toast)).toContain('Não consegui criar o ícone');
  });

  it('an IPC rejection becomes a toast and re-enables the button', async () => {
    install.mockRejectedValueOnce(new Error('ponte caiu'));
    render(linuxStatus({ enabled: false, state: 'off' }));
    await press('Mostrar na bandeja');
    expect(JSON.stringify(useToastStore.getState().toasts.at(-1))).toContain('ponte caiu');
    expect(button('Mostrar na bandeja')?.disabled).toBe(false);
  });

  it('disables the buttons while a request is in flight', async () => {
    let release: (value: { ok: boolean; message: string }) => void = () => undefined;
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(linuxStatus({ enabled: false, state: 'off' }));
    const target = button('Mostrar na bandeja');
    await act(async () => {
      target?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('button')?.disabled).toBe(true);
    expect(host.textContent).toContain('Aguarde');
    await act(async () => {
      release({ ok: true, message: 'ok' });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
