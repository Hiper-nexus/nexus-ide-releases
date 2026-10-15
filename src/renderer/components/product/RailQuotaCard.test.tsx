/** @vitest-environment jsdom */
import { act, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import type { PetLifetimeStats } from '../../../shared/pet-types';
import { RailQuotaCard } from './RailQuotaCard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom sempre tem; o guard é só higiene */
  }
});

function entry(
  id: string,
  adapterId: string,
  label: string,
  used: number | null,
  extra: Partial<ProviderQuotaEntry> = {},
): ProviderQuotaEntry {
  return {
    id,
    adapterId,
    label,
    installed: true,
    onCooldown: false,
    updatedAt: 1,
    windows:
      used === null
        ? []
        : [{ kind: 'weekly', label: 'Semanal', usedRatio: used, source: 'provider-api', confidence: 'high' }],
    ...extra,
  };
}

/** 7 contas em 6 provedores — mais que o teto recolhido (4). */
const ENTRIES: ProviderQuotaEntry[] = [
  entry('devin', 'devin', 'Devin CLI · devin', 1),
  entry('codex', 'codex', 'Codex · retornoja@gmail.com', 1),
  entry('claude-b', 'claude', 'Claude · conta b', 0.77),
  entry('claude-adm', 'claude', 'Claude · conta adm', 0.72),
  entry('kimi', 'kimi', 'Kimi', 0.2),
  entry('gemini', 'agy', 'Antigravity', 0.1),
  entry('cursor', 'cursor', 'Cursor-Agent', null),
];

const LIFETIME = { tokensBurned: 13_800_000, usdEquivalent: 1995.66 } as PetLifetimeStats;

function mount(props: Partial<React.ComponentProps<typeof RailQuotaCard>> = {}) {
  const onOpenUsage = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <RailQuotaCard
        entries={ENTRIES}
        now={Date.now()}
        lifetimeUsage={LIFETIME}
        onOpenUsage={onOpenUsage}
        {...props}
      />,
    ),
  );
  return { host, onOpenUsage };
}

const items = (host: HTMLElement) => host.querySelectorAll('.workspace-rail__quota-item');
const toggle = (host: HTMLElement) =>
  host.querySelector('.workspace-rail__cockpit-header') as HTMLButtonElement;

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Cotas das suas IAs"]');
const clickByText = (scope: ParentNode, text: string) => {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  expect(button).toBeTruthy();
  act(() => button!.click());
};

describe('RailQuotaCard', () => {
  it('opens every account in a portal above the workspace while the rail stays compact', () => {
    const { host } = mount();
    expect(items(host)).toHaveLength(4);
    act(() => toggle(host).click());
    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(host.contains(panel)).toBe(false);
    expect(document.getElementById('nexus-overlay-root')?.contains(panel)).toBe(true);
    expect(panel?.querySelectorAll('.quota-overview__account')).toHaveLength(7);
    expect(items(host)).toHaveLength(4);
    expect(panel?.textContent).toContain('Cursor-Agent');
    expect(toggle(host).getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens the foreground panel from the card body and with fewer than four accounts', () => {
    const { host, onOpenUsage } = mount({ entries: ENTRIES.slice(0, 3) });
    act(() => (host.querySelector('.workspace-rail__cockpit-bars') as HTMLElement).click());
    expect(dialog()?.querySelectorAll('.quota-overview__account')).toHaveLength(3);
    expect(onOpenUsage).not.toHaveBeenCalled();
  });

  it('ignores the legacy inline expansion preference and never reopens a modal on mount', () => {
    localStorage.setItem('nexus.rail.quotaExpanded.v1', 'expanded');
    const { host } = mount();
    expect(items(host)).toHaveLength(4);
    expect(dialog()).toBeNull();
  });

  it('closes with Escape and restores focus to the opener', () => {
    const { host } = mount();
    toggle(host).focus();
    act(() => toggle(host).click());
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    act(() => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(toggle(host));
  });

  it('keeps Tab within the foreground panel and closes from its close action', () => {
    const { host } = mount();
    act(() => toggle(host).click());
    const panel = dialog()!;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')];
    buttons.at(-1)!.focus();
    act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => panel.querySelector<HTMLButtonElement>('[aria-label="Fechar cotas"]')!.click());
    expect(dialog()).toBeNull();
  });

  it('opens settings after closing the overview', () => {
    const { host, onOpenUsage } = mount();
    act(() => toggle(host).click());
    clickByText(dialog()!, 'Uso e cotas');
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('filters missing readings and preserves confirmed zero separately from unknown', () => {
    const { host } = mount({ entries: [entry('zero', 'codex', 'Zero fixture', 0), entry('unknown', 'cursor', 'Unknown fixture', null)] });
    act(() => toggle(host).click());
    expect(dialog()?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(dialog()?.textContent).toContain('Sem leitura');
    clickByText(dialog()!, 'Resolver');
    expect(dialog()?.querySelectorAll('.quota-overview__account')).toHaveLength(1);
    expect(dialog()?.textContent).toContain('Unknown fixture');
    expect(dialog()?.querySelector('[role="meter"]')).toBeNull();
  });

  it('keeps identity-mismatch and estimated quota out of measured results', () => {
    const estimated = entry('estimate', 'glm', 'Estimate fixture', 0.25);
    estimated.windows = estimated.windows.map((window) => ({ ...window, confidence: 'low' }));
    const { host } = mount({ entries: [estimated, entry('mismatch', 'claude', 'Mismatch fixture', 0.9, { readHint: 'identity-mismatch' })] });
    act(() => toggle(host).click());
    expect(dialog()?.textContent).not.toContain('90%');
    expect(dialog()?.textContent).toContain('Estimado');
    clickByText(dialog()!, 'Com leitura');
    expect(dialog()?.querySelectorAll('.quota-overview__account')).toHaveLength(0);
  });

  it('keeps the lifetime usage summary on the rail', () => {
    const { host } = mount();
    expect(host.textContent).toContain('tok torrados');
  });

  it('closes only for an actual backdrop click, not clicks inside the panel', () => {
    const { host } = mount();
    act(() => toggle(host).click());
    act(() => dialog()!.click());
    expect(dialog()).not.toBeNull();
    act(() => document.querySelector<HTMLElement>('.quota-overview__backdrop')!.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(toggle(host));
  });

  it('preserves the settings destination focus instead of returning to the rail', () => {
    function Destination() {
      const heading = useRef<HTMLHeadingElement>(null);
      useLayoutEffect(() => { heading.current?.focus(); }, []);
      return <h2 ref={heading} tabIndex={-1}>Destino das configurações</h2>;
    }
    function Navigation() {
      const [settings, setSettings] = useState(false);
      return <><RailQuotaCard entries={ENTRIES} now={Date.now()} lifetimeUsage={null} onOpenUsage={() => setSettings(true)} />{settings && <Destination />}</>;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Navigation />));
    act(() => toggle(host).click());
    clickByText(dialog()!, 'Uso e cotas');
    expect(dialog()).toBeNull();
    expect(document.activeElement?.textContent).toBe('Destino das configurações');
  });
});
