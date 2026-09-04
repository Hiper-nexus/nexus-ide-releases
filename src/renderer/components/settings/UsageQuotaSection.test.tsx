/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaEntry, QuotaFleetSnapshot } from '../../../shared/quota-types';
import { useAccountStore } from '../../state/account-store';
import { useQuotaStore } from '../../state/quota-store';
import { UsageQuotaSection } from './UsageQuotaSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sampleEntries: ProviderQuotaEntry[] = [
  {
    id: 'claude',
    adapterId: 'claude',
    label: 'Claude · CLI nativo',
    installed: true,
    onCooldown: false,
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: 0.42,
        source: 'provider-api',
        confidence: 'high',
        remainingLabel: '3h 12m',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0.15,
        source: 'provider-api',
        confidence: 'high',
      },
    ],
    updatedAt: 1723630000000,
  },
  {
    id: 'codex:acc-1',
    adapterId: 'codex',
    accountId: 'acc-1',
    label: 'Codex · Plus',
    installed: true,
    onCooldown: true,
    cooldownKind: 'rate-limit',
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: 0.95,
        source: 'limit-hit',
        confidence: 'high',
        remainingLabel: 'cooldown 45m',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
    ],
    updatedAt: 1723630000000,
  },
  {
    id: 'opencode',
    adapterId: 'opencode',
    label: 'OpenCode',
    installed: false,
    onCooldown: false,
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
    ],
    updatedAt: 1723630000000,
  },
];

const sampleSnapshot: QuotaFleetSnapshot = {
  updatedAt: 1723630000000,
  entries: sampleEntries,
  worstUsedRatio: 0.95,
  highUsageCount: 1,
  unknownCount: 1,
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<UsageQuotaSection />));
  return { host, root };
}

describe('UsageQuotaSection', () => {
  beforeEach(() => {
    useQuotaStore.getState().reset();
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
      },
    });
  });

  afterEach(() => {
    useQuotaStore.getState().reset();
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders header, description, and status overview counters', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Uso e cotas');
    expect(host.textContent).toContain('3 entradas');
    expect(host.textContent).toContain('1 no limite');
    expect(host.textContent).toContain('1 sem telemetria');

    act(() => root.unmount());
  });

  it('renders provider entries with labels, email, cooldown, and badges', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Claude · CLI nativo');
    expect(host.textContent).toContain('Codex · Plus');
    expect(host.textContent).toContain('user@example.com');
    expect(host.textContent).toContain('ausente');
    expect(host.textContent).toContain('cooldown');

    // Windows percentages and unknown "—"
    expect(host.textContent).toContain('42%');
    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('—');

    act(() => root.unmount());
  });

  it('renders progress bar attributes correctly for known vs unknown windows', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const progressbars = host.querySelectorAll('[role="progressbar"]');
    expect(progressbars.length).toBeGreaterThanOrEqual(3);

    const first = progressbars[0];
    expect(first.getAttribute('aria-valuenow')).toBe('42');
    expect(first.getAttribute('aria-valuemin')).toBe('0');
    expect(first.getAttribute('aria-valuemax')).toBe('100');

    act(() => root.unmount());
  });

  it('renders empty state when no entries exist and status is ready', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => ({
            updatedAt: 1723630000000,
            entries: [],
            worstUsedRatio: null,
            highUsageCount: 0,
            unknownCount: 0,
          })),
          refresh: vi.fn(async () => ({
            updatedAt: 1723630000000,
            entries: [],
            worstUsedRatio: null,
            highUsageCount: 0,
            unknownCount: 0,
          })),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Nenhum CLI listado');
    expect(host.textContent).toContain('Abrir Providers');

    act(() => root.unmount());
  });

  it('renders error message when store status is error', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => {
            throw new Error('Falha de conexão IPC');
          }),
          refresh: vi.fn(async () => {
            throw new Error('Falha de conexão IPC');
          }),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Não foi possível carregar as cotas.');
    expect(host.textContent).toContain('Falha de conexão IPC');

    act(() => root.unmount());
  });

  it('dobra a linha "CLI nativo" para dentro da conta salva da mesma sessão', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
        {
          id: 'acc-2',
          adapterId: 'claude',
          label: 'Trabalho',
          mode: 'subscription',
          upstream: 'anthropic',
          email: 'dev@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: false,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    // Sonda de login: a sessão Claude viva É a conta dev@example.com do vault.
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
        providers: {
          authStatus: vi.fn(async () => [
            {
              adapterId: 'claude',
              state: 'ok',
              detail: 'sessão Claude viva: dev@example.com',
            },
          ]),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A linha nativa do Claude sumiu (redundante com a conta salva)…
    expect(host.textContent).not.toContain('Claude · CLI nativo');
    // …as contas e adapters independentes continuam lá.
    expect(host.querySelectorAll('.quota-entry').length).toBe(2);
    expect(host.textContent).toContain('2 entradas');
    act(() => root.unmount());
  });

  it('mantém a linha "CLI nativo" quando a sessão viva NÃO é conta salva', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
        providers: {
          authStatus: vi.fn(async () => [
            {
              adapterId: 'claude',
              state: 'ok',
              detail: 'sessão Claude viva: stranger@example.com',
            },
          ]),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Claude · CLI nativo');
    act(() => root.unmount());
  });

  it('triggers refresh when clicking the refresh button', async () => {
    const refreshSpy = vi.fn(async () => sampleSnapshot);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: refreshSpy,
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const btn = host.querySelector<HTMLButtonElement>('.quota-panel__refresh');
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(false);

    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });

    expect(refreshSpy).toHaveBeenCalled();
    act(() => root.unmount());
  });
});
