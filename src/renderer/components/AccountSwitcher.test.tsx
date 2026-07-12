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

  it('opens menu and roves focus with ArrowDown / ArrowUp', async () => {
    const { host, root } = mount();
    const trigger = host.querySelector<HTMLButtonElement>('.account-switcher__btn');
    expect(trigger).toBeTruthy();

    await act(async () => {
      // React 17+ onKeyDown needs a proper event path; click is the primary open.
      trigger!.click();
    });

    const menu = host.querySelector('#account-switcher-menu');
    expect(menu).toBeTruthy();

    const items = [
      ...host.querySelectorAll<HTMLButtonElement>(
        '#account-switcher-menu [role="menuitem"]:not([disabled])',
      ),
    ];
    expect(items.length).toBeGreaterThanOrEqual(2);

    // jsdom focus is flaky; assert roving by invoking key handlers and
    // checking which item receives .focus().
    const focused: HTMLElement[] = [];
    for (const item of items) {
      const orig = item.focus.bind(item);
      item.focus = () => {
        focused.push(item);
        orig();
      };
    }

    await act(async () => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(focused.at(-1)).toBe(items[1] ?? items[0]);

    await act(async () => {
      // Simulate focus on the last focused item for index math
      items[1]?.focus();
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(focused.at(-1)).toBe(items[0]);

    await act(async () => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(focused.at(-1)).toBe(items[0]);

    await act(async () => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(focused.at(-1)).toBe(items[items.length - 1]);

    await act(async () => {
      menu!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host.querySelector('#account-switcher-menu')).toBeNull();

    act(() => root.unmount());
  });
});
