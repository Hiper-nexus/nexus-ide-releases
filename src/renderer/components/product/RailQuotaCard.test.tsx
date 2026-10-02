/** @vitest-environment jsdom */
import { act } from 'react';
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

describe('RailQuotaCard', () => {
  it('starts collapsed with the 4 hungriest accounts and offers to show them all', () => {
    const { host } = mount();
    expect(items(host)).toHaveLength(4);
    expect(toggle(host).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(host).textContent).toContain('Ver todas');
    expect(toggle(host).textContent).toContain('7');
    // O nome acessível começa pelo texto visível (controle por voz: "Ver todas").
    expect(toggle(host).getAttribute('aria-label')).toMatch(/^Ver todas \(7\)/);
  });

  it('clicking the header expands to EVERY account, including unread ones', () => {
    const { host } = mount();
    act(() => toggle(host).click());
    expect(items(host)).toHaveLength(7);
    expect(toggle(host).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(host).textContent).toContain('Recolher');
    expect(host.textContent).toContain('Cursor-Agent');
    expect(host.textContent).toContain('Kimi');
  });

  it('clicking the card body (not only the header) also expands it', () => {
    const { host } = mount();
    act(() => (host.querySelector('.workspace-rail__cockpit-bars') as HTMLElement).click());
    expect(items(host)).toHaveLength(7);
  });

  it('collapses again on a second click', () => {
    const { host } = mount();
    act(() => toggle(host).click());
    act(() => toggle(host).click());
    expect(items(host)).toHaveLength(4);
    expect(toggle(host).getAttribute('aria-expanded')).toBe('false');
  });

  it('summarizes providers and accounts, and shows window detail, when expanded', () => {
    const { host } = mount();
    expect(host.querySelector('.workspace-rail__cockpit-summary')).toBeNull();
    act(() => toggle(host).click());
    expect(host.querySelector('.workspace-rail__cockpit-summary')?.textContent).toBe(
      '6 provedores · 7 contas',
    );
    expect(host.querySelector('.workspace-rail__quota-line')).not.toBeNull();
  });

  it('keeps the way to the full usage page: a button, only when expanded', () => {
    const { host, onOpenUsage } = mount();
    expect(host.querySelector('.workspace-rail__cockpit-open')).toBeNull();
    act(() => toggle(host).click());
    const open = host.querySelector('.workspace-rail__cockpit-open') as HTMLButtonElement;
    expect(open.textContent).toContain('Abrir uso e cotas');
    act(() => open.click());
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
    // Abrir os detalhes não recolhe nem expande por tabela.
    expect(items(host)).toHaveLength(7);
  });

  it('remembers the choice across mounts', () => {
    const first = mount();
    act(() => toggle(first.host).click());
    const second = mount();
    expect(items(second.host)).toHaveLength(7);
  });

  it('with 4 or fewer accounts there is nothing to expand: the card opens usage', () => {
    const { host, onOpenUsage } = mount({ entries: ENTRIES.slice(0, 3) });
    expect(items(host)).toHaveLength(3);
    expect(toggle(host).hasAttribute('aria-expanded')).toBe(false);
    expect(toggle(host).textContent).not.toContain('Ver todas');
    act(() => toggle(host).click());
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
    expect(items(host)).toHaveLength(3);
  });

  it('still shows the lifetime consumption line in both states', () => {
    const { host } = mount();
    expect(host.textContent).toContain('tok torrados');
    act(() => toggle(host).click());
    expect(host.textContent).toContain('tok torrados');
  });

  it('exposes the expanded list as a labelled region wired to the toggle', () => {
    const { host } = mount();
    act(() => toggle(host).click());
    const controls = toggle(host).getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const region = host.querySelector(`[id="${controls}"]`);
    expect(region).not.toBeNull();
    expect(region?.getAttribute('role')).toBe('list');
  });
});
