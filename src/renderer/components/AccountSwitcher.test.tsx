/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../shared/account-types';
import { useAccountStore } from '../state/account-store';
import { useSettingsStore } from '../state/settings-store';
import { AccountSwitcher } from './AccountSwitcher';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function account(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'a1',
    adapterId: 'claude',
    label: 'Trabalho',
    mode: 'subscription',
    upstream: 'anthropic',
    createdAt: 1,
    active: true,
    hasCredential: true,
    onCooldown: false,
    ...patch,
  };
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AccountSwitcher />));
  return { host, root };
}

describe('AccountSwitcher keyboard', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [
        account(),
        account({
          id: 'a2',
          label: 'Pessoal',
          active: false,
        }),
      ],
      quota: [],
      restartAdapterId: null,
      restartLabel: null,
      activate: vi.fn(async () => ({ ok: true })),
    } as never);
    useSettingsStore.setState({ openDrawer: vi.fn() } as never);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens portaled menu with account items and closes on Escape', async () => {
    const { host, root } = mount();
    const trigger = host.querySelector<HTMLButtonElement>('.account-switcher__btn');
    expect(trigger).toBeTruthy();

    await act(async () => {
      trigger!.click();
    });

    // Menu is portaled to document.body (escapes rail overflow:hidden).
    const menu = document.querySelector('#account-switcher-menu');
    expect(menu).toBeTruthy();
    expect(menu?.classList.contains('account-switcher__menu--fixed')).toBe(true);

    const items = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '#account-switcher-menu [role="menuitem"]:not([disabled])',
      ),
    ];
    expect(items.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.querySelector('#account-switcher-menu')).toBeNull();

    act(() => root.unmount());
  });
});
