import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CHANNELS } from '../../shared/billing-types';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    openExternal: vi.fn(),
  };
});

const billingDeps = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  startCheckoutPolling: vi.fn(),
  applyLicense: vi.fn((_jwt: string): { ok: boolean; error?: string } => ({ ok: true })),
  canUseApp: vi.fn((): boolean => true),
}));

/** Evento de um renderer confiável; qualquer outro remetente é recusado. */
const TRUSTED = { trusted: true };

// handleTrusted real depende da janela principal registrada; aqui só importa a regra: sem remetente confiável, nada roda.
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    electronMock.handle(channel, (event: unknown, ...args: unknown[]) => {
      if (!(event as { trusted?: boolean } | null)?.trusted) throw new Error('ipc sender não autorizado');
      return handler(event, ...args);
    });
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  shell: { openExternal: electronMock.openExternal },
}));

describe('registerBillingIpc', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    electronMock.handlers.clear();
    // clearAllMocks não reseta implementações: sem isto, um teste vaza `{ ok:false }` para o seguinte.
    billingDeps.applyLicense.mockReturnValue({ ok: true });
    billingDeps.canUseApp.mockReturnValue(true);
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url: 'https://checkout.stripe.com/session' } },
    });
    const mod = await import('./billing-ipc');
    mod.registerBillingIpc({
      apiFetch: billingDeps.apiFetch,
      openExternal: electronMock.openExternal,
      startCheckoutPolling: billingDeps.startCheckoutPolling,
      applyLicense: billingDeps.applyLicense,
      canUseApp: billingDeps.canUseApp,
    });
  });

  it('repassa o checkout Pro como único plano pago', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);
    expect(handler).toBeDefined();

    const result = await handler?.(null, { plan: 'pro' });

    expect(result).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'pro' },
    });
    expect(electronMock.openExternal).toHaveBeenCalledWith(
      'https://checkout.stripe.com/session',
    );
    expect(billingDeps.startCheckoutPolling).toHaveBeenCalledTimes(1);
  });

  it('recusa plano inválido sem mapear para Pro', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, 'free');

    expect(result).toEqual({ ok: false, error: 'plano inválido' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it('mantém o corpo mensal sem cupom e encaminha período ou código', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);
    expect(await handler?.(null, 'pro')).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenLastCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'pro' },
    });

    expect(await handler?.(null, { plan: 'pro', interval: 'quarter' })).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenLastCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'pro', interval: 'quarter' },
    });

    expect(await handler?.(null, { plan: 'pro', interval: 'year', coupon: ' nexus 10 ' })).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenLastCalledWith('/v1/billing/checkout', {
      method: 'POST',
      body: { plan: 'pro', interval: 'year', coupon: 'NEXUS10' },
    });
  });

  it('recusa cupom malformado ou período desconhecido sem chamar a API', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);
    expect(await handler?.(null, { plan: 'pro', coupon: '!!' })).toEqual({ ok: false, error: 'Cupom inválido.' });
    expect(await handler?.(null, { plan: 'pro', interval: 'week' })).toEqual({ ok: false, error: 'plano inválido' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
  });

  it('recusa o plano Team legado no checkout', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, { plan: 'team', seats: 3 });

    expect(result).toEqual({ ok: false, error: 'plano inválido' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://insecure.example/checkout',
    'https://evil.example/checkout',
  ])('recusa URL de checkout sem https: %s', async (url) => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url } },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.checkout);

    const result = await handler?.(null, { plan: 'pro' });

    expect(result).toEqual({ ok: false, error: 'URL de checkout inválida' });
    expect(electronMock.openExternal).not.toHaveBeenCalled();
    expect(billingDeps.startCheckoutPolling).not.toHaveBeenCalled();
  });

  it('recusa URL de portal sem https:', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { url: 'javascript:alert(1)' } },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.portal);

    const result = await handler?.(null);

    expect(result).toEqual({ ok: false, error: 'URL do portal inválida' });
    expect(electronMock.openExternal).not.toHaveBeenCalled();
  });

  it('resgate aplica a licença assinada que o backend devolve', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { licenca: 'jwt.assinado' } },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = await handler?.(TRUSTED, '  NEXUS-AAAA-BBBB-CCCC  ');

    expect(result).toEqual({ ok: true });
    expect(billingDeps.apiFetch).toHaveBeenCalledWith('/v1/license/redeem', {
      method: 'POST',
      body: { code: 'NEXUS-AAAA-BBBB-CCCC' },
    });
    expect(billingDeps.applyLicense).toHaveBeenCalledWith('jwt.assinado');
  });

  it('resgate recusa entrada que não é código antes de chamar o backend', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    expect(await handler?.(TRUSTED, 42)).toEqual({ ok: false, error: 'Código inválido.' });
    expect(await handler?.(TRUSTED, '   ')).toEqual({ ok: false, error: 'Código inválido.' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
  });

  it('resgate repassa a recusa do backend sem aplicar licença', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 400,
      json: { ok: false, error: 'Código inválido, expirado ou já utilizado.' },
    });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC');

    expect(result).toEqual({ ok: false, error: 'Código inválido, expirado ou já utilizado.' });
    expect(billingDeps.applyLicense).not.toHaveBeenCalled();
  });

  it('resgate exige conta logada: 401 vira instrução de login', async () => {
    billingDeps.apiFetch.mockResolvedValue({ status: 401, json: null });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC');

    expect(result).toEqual({
      ok: false,
      error: 'Entre na sua conta Nexus para resgatar um código',
    });
    expect(billingDeps.applyLicense).not.toHaveBeenCalled();
  });

  it('resgate falha limpo quando a licença devolvida não valida', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { licenca: 'jwt.ruim' } },
    });
    billingDeps.applyLicense.mockReturnValue({ ok: false, error: 'assinatura' });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC');

    expect(result).toEqual({
      ok: false,
      error: 'A licença recebida não pôde ser validada. Tente novamente.',
    });
  });

  it('resgate recusa remetente que não é a janela principal, sem tocar no backend', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    expect(() => handler?.(null, 'NEXUS-AAAA-BBBB-CCCC')).toThrow('ipc sender não autorizado');
    expect(() => handler?.({ trusted: false }, 'NEXUS-AAAA-BBBB-CCCC')).toThrow('ipc sender não autorizado');
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();
    expect(billingDeps.applyLicense).not.toHaveBeenCalled();
  });

  it('resgate nunca diz ok para uma licença que não abre o app', async () => {
    billingDeps.apiFetch.mockResolvedValue({
      status: 200,
      json: { ok: true, data: { licenca: 'jwt.inativa' } },
    });
    billingDeps.canUseApp.mockReturnValue(false);
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC');

    expect(result).toEqual({
      ok: false,
      error: 'O código foi aceito, mas não liberou o acesso. Ele pode ter expirado.',
    });
  });

  it('resgate com o backend fora do ar mostra frase para a pessoa, não texto técnico', async () => {
    billingDeps.apiFetch.mockResolvedValue({ status: 0, json: null });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = (await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC')) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Não consegui falar com o servidor. Tente de novo em instantes.');
  });

  it('resgate respeita os limites de tamanho do código (4 a 80)', async () => {
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    expect(await handler?.(TRUSTED, 'abc')).toEqual({ ok: false, error: 'Código inválido.' });
    expect(await handler?.(TRUSTED, 'x'.repeat(81))).toEqual({ ok: false, error: 'Código inválido.' });
    expect(billingDeps.apiFetch).not.toHaveBeenCalled();

    billingDeps.apiFetch.mockResolvedValue({ status: 400, json: { ok: false, error: 'Código inválido, expirado ou já utilizado.' } });
    await handler?.(TRUSTED, 'abcd');
    await handler?.(TRUSTED, 'x'.repeat(80));
    expect(billingDeps.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('resgate com resposta 200 sem licença assinada é falha, não sucesso', async () => {
    billingDeps.apiFetch.mockResolvedValue({ status: 200, json: { ok: true, data: {} } });
    const handler = electronMock.handlers.get(BILLING_CHANNELS.redeem);

    const result = (await handler?.(TRUSTED, 'NEXUS-AAAA-BBBB-CCCC')) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(billingDeps.applyLicense).not.toHaveBeenCalled();
  });
});
