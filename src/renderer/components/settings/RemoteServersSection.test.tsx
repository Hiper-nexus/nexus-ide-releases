/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSshHostView } from '../../../shared/remote-types';
import { RemoteServersSection } from './RemoteServersSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<RemoteServersSection />);
  });
  return { host, root };
}

function setInputValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('HTMLInputElement value setter unavailable');
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RemoteServersSection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        remote: {
          listSshHosts: vi.fn(async () => []),
          connectSshHost: vi.fn(async () => ({ ok: true, alias: 'vps-1' })),
          importSshConfig: vi.fn(async () => ({
            ok: true,
            imported: [],
            skipped: 0,
          })),
          removeSshHost: vi.fn(async () => ({ ok: true, alias: 'vps-1' })),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('ensina o fluxo em três passos quando não há servidor', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toMatch(/Nenhum servidor pelo apelido/);
    expect(host.textContent).toMatch(/Conectar/);
    expect(host.textContent).toMatch(/Chave criada/);
    expect(host.textContent).toMatch(/Agente só fala o apelido/);
    expect(host.textContent).toMatch(/ssh vps-1/);
    act(() => root.unmount());
  });

  it('abre o formulário de conectar e limpa a senha depois do envio', async () => {
    const onHostsChange = vi.fn();
    const listSshHosts = vi.fn(async (): Promise<RemoteSshHostView[]> => []);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        remote: {
          listSshHosts,
          connectSshHost: vi.fn(async () => {
            listSshHosts.mockResolvedValueOnce([
              {
                alias: 'vps-1',
                source: 'nexus',
                user: 'ubuntu',
                ready: true,
                hasNexusKey: true,
              },
            ]);
            return { ok: true, alias: 'vps-1' };
          }),
          importSshConfig: vi.fn(async () => ({
            ok: true,
            imported: [],
            skipped: 0,
          })),
          removeSshHost: vi.fn(async () => ({ ok: true, alias: 'vps-1' })),
        },
      },
    });
    const hostEl = document.createElement('div');
    document.body.appendChild(hostEl);
    const root = createRoot(hostEl);
    act(() => {
      root.render(<RemoteServersSection onHostsChange={onHostsChange} />);
    });
    const host = hostEl;
    await act(async () => {
      await Promise.resolve();
    });
    const open = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Conectar servidor'),
    );
    expect(open).toBeTruthy();
    await act(async () => {
      open!.click();
    });
    const alias = host.querySelector('input[placeholder="vps-1"]') as HTMLInputElement;
    const address = host.querySelector(
      'input[placeholder="só desta vez"]',
    ) as HTMLInputElement;
    const user = host.querySelector('input[placeholder="ubuntu"]') as HTMLInputElement;
    const password = host.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(alias, 'vps-1');
      setInputValue(address, '10.0.0.8');
      setInputValue(user, 'ubuntu');
      setInputValue(password, 'hunter2');
    });
    const submit = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Conectar e criar chave'),
    );
    await act(async () => {
      submit!.click();
      await Promise.resolve();
    });
    expect(window.nexus.remote.connectSshHost).toHaveBeenCalledWith({
      alias: 'vps-1',
      host: '10.0.0.8',
      user: 'ubuntu',
      password: 'hunter2',
      port: undefined,
    });
    expect(onHostsChange).toHaveBeenCalledWith([
      expect.objectContaining({ alias: 'vps-1', hasNexusKey: true }),
    ]);
    expect(
      (host.querySelector('input[type="password"]') as HTMLInputElement | null)?.value ??
        '',
    ).toBe('');
    act(() => root.unmount());
  });
});
