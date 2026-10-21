import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn),
}));

import { JEV_CHANNELS } from '../../shared/jev-channels';
import { PANE_ROUTE_REQUEST_MAX, type PaneRouteResult } from '../../shared/pane-route';
import { registerPaneRouteIpc } from './jev-pane-route-ipc';

const ok: PaneRouteResult = {
  ok: true,
  proposal: { tier: 'hard', reason: 'tier hard', source: 'jev', effort: 'high' },
};

function call(...args: unknown[]): Promise<unknown> {
  const handler = h.handlers.get(JEV_CHANNELS.paneRoute);
  if (!handler) throw new Error('no handler registered');
  return Promise.resolve(handler({}, ...args));
}

describe('registerPaneRouteIpc', () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it('registra exatamente um canal, atrás da guarda de remetente confiável', () => {
    registerPaneRouteIpc(vi.fn());
    expect([...h.handlers.keys()]).toEqual([JEV_CHANNELS.paneRoute]);
    expect(JEV_CHANNELS.paneRoute).toBe('jev:paneRoute');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['um número', 42],
    ['uma string', 'oi'],
    ['objeto vazio', {}],
    ['pedido vazio', { request: '' }],
    ['pedido acima do teto', { request: 'a'.repeat(PANE_ROUTE_REQUEST_MAX + 1) }],
    ['missionId — o renderer não envia autoridade', { request: 'x', missionId: 'm1' }],
    ['sessionId — idem', { request: 'x', sessionId: 's1' }],
    ['accountId — idem', { request: 'x', accountId: 'a1' }],
  ])('recusa %s com resposta tipada, sem chegar ao modelo', async (_label, payload) => {
    const propose = vi.fn();
    registerPaneRouteIpc(propose);
    await expect(call(payload)).resolves.toEqual({ ok: false, reason: 'empty' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('entrega o pedido válido e devolve a proposta', async () => {
    const propose = vi.fn(async () => ok);
    registerPaneRouteIpc(propose);
    await expect(call({ request: 'arruma o login' })).resolves.toEqual(ok);
    expect(propose).toHaveBeenCalledWith({ request: 'arruma o login' });
  });

  it('aceita a CLI que o operador já escolheu na mão', async () => {
    const propose = vi.fn(async () => ok);
    registerPaneRouteIpc(propose);
    await call({ request: 'x', adapterId: 'codex' });
    expect(propose).toHaveBeenCalledWith({ request: 'x', adapterId: 'codex' });
  });

  it('exceção do serviço vira resultado, nunca erro no renderer', async () => {
    registerPaneRouteIpc(async () => {
      throw new Error('boom');
    });
    await expect(call({ request: 'x' })).resolves.toEqual({ ok: false, reason: 'error' });
  });

  it('nenhum texto de falha do Main vaza para o renderer', async () => {
    registerPaneRouteIpc(async () => {
      throw new Error('/Users/alguem/.nexus/segredo.json ENOENT');
    });
    const result = await call({ request: 'x' });
    expect(JSON.stringify(result)).not.toContain('segredo');
    expect(JSON.stringify(result)).not.toContain('Users');
  });
});
