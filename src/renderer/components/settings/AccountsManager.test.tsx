/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import { useAccountStore } from '../../state/account-store';
import { useConfirmStore } from '../../state/confirm-store';
import { AccountsManager } from './AccountsManager';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function account(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'acct-1',
    adapterId: 'claude',
    label: 'Trabalho',
    mode: 'subscription',
    upstream: 'anthropic',
    email: 'dev@example.com',
    createdAt: 1,
    active: true,
    hasCredential: true,
    onCooldown: false,
    ...patch,
  };
}

function mount(adapterId = 'claude'): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AccountsManager adapterId={adapterId} />));
  return { host, root };
}

describe('AccountsManager', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      quota: [],
      restartAdapterId: null,
      restartLabel: null,
    });
    useConfirmStore.setState({ pending: null, queue: [] });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'claude', state: 'ok', detail: 'Logged in as dev@example.com' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: true })),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows implicit native session when vault is empty', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Sessão nativa de claude');
    expect(host.textContent).toContain('Login verificado');
    expect(host.textContent).toContain('API key');
    expect(host.textContent).toMatch(/multi-conta/i);
    expect(host.textContent).toMatch(/adicionar a 1ª conta/i);
    expect(host.textContent).toMatch(/nenhuma conta reserva/i);
    expect(host.textContent).toMatch(/2ª conta|outra conta/i);
    // Snapshot button appears after supportsSnapshot resolves.
    expect(host.textContent).toMatch(/sessão logada/i);
    act(() => root.unmount());
  });

  it('renders active roster row with explicit actions (not glyph-only)', async () => {
    useAccountStore.setState({
      accounts: [
        account(),
        account({
          id: 'acct-2',
          label: 'Pessoal',
          active: false,
          email: 'home@example.com',
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Trabalho');
    expect(host.textContent).toContain('Em uso');
    expect(host.textContent).toContain('Pessoal');
    expect(host.textContent).toContain('Sincronizar');
    expect(host.textContent).toContain('Renomear');
    expect(host.textContent).toContain('Remover');
    expect(host.textContent).toContain('Usar');
    expect(host.querySelector('.acct__mini')).toBeNull();
    act(() => root.unmount());
  });

  it('renames inline instead of window.prompt', async () => {
    const rename = vi.fn(async () => undefined);
    useAccountStore.setState({
      accounts: [account()],
      rename,
      hydrate: vi.fn(async () => undefined),
    } as never);

    const promptSpy = vi.spyOn(window, 'prompt');
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const renameBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Renomear',
    );
    expect(renameBtn).toBeTruthy();
    await act(async () => renameBtn!.click());

    const input = host.querySelector<HTMLInputElement>('.acct__rename-input');
    expect(input).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();

    await act(async () => {
      input!.value = 'Escritório';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Controlled input needs React change simulation
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeInputValueSetter?.call(input!, 'Escritório');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Salvar nome',
    );
    expect(save).toBeTruthy();
    act(() => root.unmount());
  });
});
