/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LICENSE } from '../../../shared/billing-types';
import type { LoginResultEvent } from '../../../shared/auth-login';
import { AccountSection } from './AccountSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let emitAuthResult: (result: LoginResultEvent) => void = () => {};

function mount(accessOnly = false): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AccountSection accessOnly={accessOnly} />));
  return { host, root };
}

describe('AccountSection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        billing: {
          onChanged: () => () => {},
          get: vi.fn(async () => ({
            plan: 'free',
            email: null,
            status: 'none',
            renewsAt: null,
          })),
          openCheckout: vi.fn(async () => ({ ok: true })),
          openPortal: vi.fn(async () => ({ ok: true })),
          redeemCode: vi.fn(async () => ({ ok: true })),
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
          onAuthLoginResult: (cb: (result: LoginResultEvent) => void) => {
            emitAuthResult = cb;
            return () => {};
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps recovery actions available on the blocked screen when the snapshot fails', async () => {
    vi.mocked(window.nexus.billing.get).mockRejectedValue(new Error('offline'));
    const { host, root } = mount(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('Entrar com GitHub');
    expect(host.textContent).toContain('Assinar Pro');
    expect(host.textContent).toContain('Gerenciar assinatura');
    expect(host.textContent).toContain('Tentar novamente');
    expect(host.textContent).not.toContain('Invalid Date');
    expect(host.querySelector('[aria-label="Time"]')).toBeNull();
    act(() => root.unmount());
  });

  it('redeems a license code from the blocked screen and refreshes access', async () => {
    // Resgate exige conta: a licença mockada precisa vir com e-mail.
    vi.mocked(window.nexus.billing.get).mockResolvedValue({
      ...DEFAULT_LICENSE, email: 'op@nexus.dev', verified: true,
      access: 'inactive', blockedReason: 'inactive', status: 'none',
    });
    const { host, root } = mount(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
    await act(async () => button('Tenho um código').click());
    const input = host.querySelector<HTMLInputElement>('.license-code input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'NEXUS-AAAA-BBBB-CCCC');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Ativar').click());
    expect(window.nexus.billing.redeemCode).toHaveBeenCalledWith('NEXUS-AAAA-BBBB-CCCC');
    expect(host.textContent).toContain('Licença ativada');
    act(() => root.unmount());
  });

  it('shows the backend refusal when the code is rejected', async () => {
    vi.mocked(window.nexus.billing.get).mockResolvedValue({
      ...DEFAULT_LICENSE, email: 'op@nexus.dev', verified: true,
      access: 'inactive', blockedReason: 'inactive', status: 'none',
    });
    vi.mocked(window.nexus.billing.redeemCode).mockResolvedValue({ ok: false, error: 'Código inválido, expirado ou já utilizado.' });
    const { host, root } = mount(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
    await act(async () => button('Tenho um código').click());
    const input = host.querySelector<HTMLInputElement>('.license-code input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'NEXUS-AAAA-BBBB-CCCC');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Ativar').click());
    expect(host.querySelector('.license-code [role="alert"]')?.textContent).toContain('Código inválido');
    expect(host.textContent).not.toContain('Licença ativada');
    act(() => root.unmount());
  });

  it('redeems a code from Minha Conta (settings tab) and refreshes the license', async () => {
    // A aba Minha Conta tem o próprio ponto de entrada: logado e ainda sem Pro.
    vi.mocked(window.nexus.billing.get).mockResolvedValue({
      ...DEFAULT_LICENSE, email: 'op@nexus.dev', verified: true,
      access: 'inactive', blockedReason: 'inactive', status: 'none',
    });
    const { host, root } = mount(false);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const redeem = host.querySelector('.account__redeem');
    expect(redeem, 'logado sem Pro deve ver "Tenho um código" em Minha Conta').not.toBeNull();
    const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
    const getCalls = vi.mocked(window.nexus.billing.get).mock.calls.length;
    await act(async () => button('Tenho um código').click());
    const input = host.querySelector<HTMLInputElement>('.license-code input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'NEXUS-AAAA-BBBB-CCCC');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Ativar').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(window.nexus.billing.redeemCode).toHaveBeenCalledWith('NEXUS-AAAA-BBBB-CCCC');
    // Depois do resgate a licença é relida (o main já aplicou o token e avisou billing:changed).
    expect(vi.mocked(window.nexus.billing.get).mock.calls.length).toBeGreaterThan(getCalls);
    act(() => root.unmount());
  });

  it('hides the code entry from Minha Conta when signed out or already Pro', async () => {
    const signedOut = mount(false);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(signedOut.host.querySelector('.account__redeem')).toBeNull();
    act(() => signedOut.root.unmount());

    vi.mocked(window.nexus.billing.get).mockResolvedValue({
      ...DEFAULT_LICENSE, email: 'op@nexus.dev', verified: true, plan: 'pro',
      access: 'pro', blockedReason: null, canUseApp: true, status: 'active',
    });
    const pro = mount(false);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(pro.host.querySelector('.account__redeem')).toBeNull();
    act(() => pro.root.unmount());
  });

  it('shows a recoverable error when the blocked-screen checkout or portal rejects', async () => {
    vi.mocked(window.nexus.billing.openCheckout).mockRejectedValue(new Error('private detail'));
    vi.mocked(window.nexus.billing.openPortal).mockRejectedValue(new Error('private detail'));
    const { host, root } = mount(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
    await act(async () => button('Assinar Pro').click());
    expect(host.textContent).toContain('Não foi possível abrir o checkout');
    expect(button('Assinar Pro').disabled).toBe(false);
    await act(async () => button('Gerenciar assinatura').click());
    expect(host.textContent).toContain('Não foi possível abrir o portal');
    expect(host.textContent).not.toContain('private detail');
    act(() => root.unmount());
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
    expect(host.textContent).not.toContain('Grátis para sempre');
    act(() => root.unmount());
  });

  it('offers recovery without showing purchase actions when the account cannot load', async () => {
    vi.mocked(window.nexus.billing.get).mockRejectedValueOnce(new Error('internal-license-debug'));
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('Não foi possível carregar sua conta');
    expect(host.textContent).not.toContain('internal-license-debug');
    expect(host.querySelectorAll('.account__plan')).toHaveLength(0);
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Tentar novamente');
    await act(async () => retry!.click());
    expect(host.textContent).toContain('Conta local (sem login)');
    expect(window.nexus.billing.openCheckout).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('oferece teste de 15 dias e Pro, sem acesso gratuito permanente', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const planCards = [...host.querySelectorAll<HTMLElement>('.account__plan')];
    expect(planCards).toHaveLength(2);
    expect(planCards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Teste de 15 dias'),
      expect.stringContaining('Pro'),
    ]);
    expect(planCards[0].textContent).toContain('primeiro login verificado');
    expect(host.textContent).toContain('Teste de 15 dias · 2 agentes · sem sync na nuvem');
    expect(host.textContent).not.toContain('não expira');
    expect(planCards[1].textContent).toMatch(/R\$\s*59,99/);
    expect(planCards[1].textContent).toContain('Preço promocional');
    expect(planCards.some((card) => card.textContent?.includes('Team'))).toBe(false);
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

  it('never paints the session green while the subscription is unconfirmed', async () => {
    (window.nexus.billing.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: 'pro',
      email: 'op@nexus.dev',
      status: 'active',
      renewsAt: null,
      verified: false,
    });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const pill = host.querySelector('.account__session-pill')!;
    expect(host.textContent).toContain('Assinatura não confirmada agora');
    expect(pill.textContent).toBe('a confirmar');
    expect(pill.classList.contains('account__session-pill--in')).toBe(false);
    expect(pill.classList.contains('account__session-pill--warn')).toBe(true);
    act(() => root.unmount());
  });

  it('shows "sessão expirada" and lets the person sign in again', async () => {
    (window.nexus.billing.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: 'free',
      email: 'op@nexus.dev',
      status: 'none',
      renewsAt: null,
      verified: true,
    });
    const teamGet = window.nexus.team.get as ReturnType<typeof vi.fn>;
    teamGet.mockResolvedValueOnce({
      ok: false,
      error: 'Sua sessão Nexus expirou — saia e entre de novo na conta',
    });
    teamGet.mockResolvedValue({ ok: true, data: null });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const pill = host.querySelector('.account__session-pill')!;
    expect(pill.textContent).toBe('sessão expirada');
    expect(pill.classList.contains('account__session-pill--in')).toBe(false);
    expect(host.textContent).not.toContain('Entrar com GitHub');

    const relogin = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Entrar de novo')!;
    // Sempre há saída: Cancelar fecha o painel sem mexer na sessão.
    await act(async () => relogin.click());
    const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancelar')!;
    await act(async () => cancel.click());
    expect(host.textContent).not.toContain('Entrar com GitHub');
    expect(window.nexus.app.authLogin).not.toHaveBeenCalled();
    const reloginAgain = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Entrar de novo')!;
    await act(async () => reloginAgain.click());
    const github = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Entrar com GitHub'))!;
    await act(async () => { github.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(window.nexus.app.authLogin).toHaveBeenCalledWith('github');
    // Navegador aberto NÃO é login feito: a tela espera e não finge sucesso.
    expect(host.textContent).toContain('Continue no navegador');
    expect(host.querySelector('.account__session-pill')!.textContent).toBe('sessão expirada');
    expect(teamGet).toHaveBeenCalledTimes(1);

    // O deep link voltou e a conta foi confirmada: só agora a sessão renova.
    await act(async () => { emitAuthResult({ ok: true }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(teamGet).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.account__session-pill')!.textContent).toBe('conectado');
    expect(host.textContent).not.toContain('Entrar com GitHub');
    expect(host.textContent).not.toContain('Continue no navegador');
    act(() => root.unmount());
  });
});


it.each(['2026-10-10T12:00:00.000Z', null])('offers Pro checkout during trial with deadline %s', async trialEndsAt => {
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    billing: { get: async () => ({ plan: 'pro', access: 'trial', email: 'a@example.test', status: 'active', verified: true, trialEndsAt }), openCheckout: vi.fn(), onChanged: () => () => {} },
    team: { get: async () => ({ ok: true, data: null }) },
  } });
  const { host, root } = mount();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Assinar Pro')).toBe(true);
  expect(host.textContent).not.toContain('Assinatura ativa');
  expect(host.textContent).not.toMatch(/1969|1970/);
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'nexus');
});


it.each([true, false])('M1: offers a local re-evaluation for verification-unavailable (accessOnly=%s)', async accessOnly => {
  Object.defineProperty(window, 'nexus', { configurable: true, value: { billing: {
    get: vi.fn().mockResolvedValueOnce({ ...DEFAULT_LICENSE, blockedReason: 'verification-unavailable' }).mockResolvedValue({ ...DEFAULT_LICENSE, canUseApp: true, access: 'pro', blockedReason: null }),
    onChanged: () => () => {},
  } } });
  const { host, root } = mount(accessOnly);
  try {
    await act(async () => {});
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Tentar novamente');
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(window.nexus.billing.get).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Tentar novamente');
  } finally { act(() => root.unmount()); host.remove(); }
});
