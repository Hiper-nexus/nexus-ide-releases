/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSection } from './AccountSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AccountSection />));
  return { host, root };
}

describe('AccountSection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        billing: {
          get: vi.fn(async () => ({
            plan: 'free',
            email: null,
            status: 'none',
            renewsAt: null,
          })),
          openCheckout: vi.fn(async () => ({ ok: true })),
          openPortal: vi.fn(async () => ({ ok: true })),
        },
        team: {
          get: vi.fn(async () => ({ ok: true, data: null })),
          join: vi.fn(async () => ({ ok: true })),
          invite: vi.fn(async () => ({ ok: true, data: { url: 'https://x' } })),
          leave: vi.fn(async () => ({ ok: true })),
          removeMember: vi.fn(async () => ({ ok: true })),
        },
        app: {
          authLogin: vi.fn(async () => ({ ok: true })),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows local session and login CTAs when not signed in', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Conta local (sem login)');
    expect(host.textContent).toContain('Entrar com GitHub');
    expect(host.textContent).toContain('Entrar com Google');
    expect(host.textContent).toContain('Providers');
    expect(host.textContent).toContain('plano atual');
    act(() => root.unmount());
  });

  it('shows team zone and hides login when signed in', async () => {
    (window.nexus.billing.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: 'pro',
      email: 'op@nexus.dev',
      status: 'active',
      renewsAt: null,
    });
    (window.nexus.team.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        team: { id: 't1', name: 'Bridge', role: 'owner' },
        members: [
          { accountId: 'm1', name: 'Ada', email: 'a@x.com', role: 'member' },
        ],
        seats: { used: 1, total: 5 },
        overLimit: false,
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('op@nexus.dev');
    expect(host.textContent).toContain('conectado');
    expect(host.textContent).toContain('Bridge');
    expect(host.textContent).toContain('Ada');
    expect(host.textContent).toContain('Gerar convite');
    expect(host.textContent).not.toContain('Entrar com GitHub');
    act(() => root.unmount());
  });
});
