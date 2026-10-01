import { afterEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CHANNELS } from '../shared/billing-types';
import { WINDOW_CHANNELS } from '../shared/channels';
import { finishAuthDeepLink } from './auth-deep-link';

afterEach(() => vi.restoreAllMocks());

const link = { code: 'c0de', state: 'st4te' };

describe('finishAuthDeepLink', () => {
  it('login concluído: avisa o billing e entrega { ok: true } ao renderer', async () => {
    const notify = vi.fn();
    await finishAuthDeepLink(link, notify, vi.fn().mockResolvedValue({ ok: true }));
    expect(notify).toHaveBeenCalledWith(BILLING_CHANNELS.changed);
    expect(notify).toHaveBeenCalledWith(WINDOW_CHANNELS.authLoginResult, { ok: true });
  });

  it('troca recusada: a tela recebe a mensagem para a pessoa, nunca o código bruto', async () => {
    const notify = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishAuthDeepLink(link, notify, vi.fn().mockResolvedValue({ ok: false, error: 'exchange-storage' }));
    const [, payload] = notify.mock.calls.find(([channel]) => channel === WINDOW_CHANNELS.authLoginResult)!;
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('cofre de credenciais');
    expect(payload.error).not.toContain('exchange-storage');
  });

  it('exceção na troca vira falha com mensagem genérica, sem vazar a causa', async () => {
    const notify = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishAuthDeepLink(link, notify, vi.fn().mockRejectedValue(new Error('token=SECRET123')));
    const [, payload] = notify.mock.calls.find(([channel]) => channel === WINDOW_CHANNELS.authLoginResult)!;
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('SECRET123');
  });

  it('o log registra só o código da falha, nunca o code/state do deep link', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishAuthDeepLink(link, vi.fn(), vi.fn().mockResolvedValue({ ok: false, error: 'exchange-http' }));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('exchange-http');
    expect(logged).not.toContain('c0de');
    expect(logged).not.toContain('st4te');
  });

  it('repassa code e state exatamente como vieram do deep link', async () => {
    const exchange = vi.fn().mockResolvedValue({ ok: true });
    await finishAuthDeepLink(link, vi.fn(), exchange);
    expect(exchange).toHaveBeenCalledWith('c0de', 'st4te');
  });

  it('janela destruída durante a troca nunca vira promise rejeitada', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(() => { throw new Error('Object has been destroyed'); });
    await expect(finishAuthDeepLink(link, notify, vi.fn().mockResolvedValue({ ok: true }))).resolves.toBeUndefined();
  });

  it.each(['nenhum login pendente', 'state não confere com o login pendente'])(
    'link velho/forjado (%s) chega marcado como stale para não derrubar a espera',
    async (error) => {
      const notify = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await finishAuthDeepLink(link, notify, vi.fn().mockResolvedValue({ ok: false, error }));
      const [, payload] = notify.mock.calls.find(([channel]) => channel === WINDOW_CHANNELS.authLoginResult)!;
      expect(payload).toMatchObject({ ok: false, stale: true });
    },
  );

  it('falha real da troca NÃO é stale', async () => {
    const notify = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await finishAuthDeepLink(link, notify, vi.fn().mockResolvedValue({ ok: false, error: 'exchange-http' }));
    const [, payload] = notify.mock.calls.find(([channel]) => channel === WINDOW_CHANNELS.authLoginResult)!;
    expect(payload.stale).toBeUndefined();
  });
});
