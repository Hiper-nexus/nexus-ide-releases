import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerRpc } from './codex-app-server-rpc';
import { codexAccountRequiresLogin, requestAllCodexModels } from './codex-model-list';

// Formato do `model/list` (V2ModelListResponse) com nomes sintéticos.
const row = (model: string, extra: Record<string, unknown> = {}) => ({
  id: model,
  model,
  displayName: model.toUpperCase(),
  description: '',
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: '' },
    { reasoningEffort: 'medium', description: '' },
  ],
  ...extra,
});

function fakeRpc(pages: Record<string, unknown>): CodexAppServerRpc & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    notify: vi.fn(),
    async request(method, params) {
      expect(method).toBe('model/list');
      calls.push(params);
      const cursor = (params as { cursor?: string } | undefined)?.cursor ?? '';
      return pages[cursor];
    },
  };
}

describe('F-990 (PRV-03) — model/list do app-server do Codex', () => {
  it('junta 2 páginas, descarta o hidden e guarda default e esforços por modelo', async () => {
    const rpc = fakeRpc({
      '': { data: [row('x-sol', { isDefault: true }), row('x-secret', { hidden: true })], nextCursor: 'page-2' },
      'page-2': {
        data: [row('x-luna', {
          supportedReasoningEfforts: [{ reasoningEffort: 'xhigh', description: '' }],
          upgrade: 'x-sol',
        })],
        nextCursor: null,
      },
    });
    const listing = await requestAllCodexModels(rpc);
    expect(rpc.calls).toEqual([{}, { cursor: 'page-2' }]);
    expect(listing.ids).toEqual(['x-sol', 'x-luna']);
    expect(listing.hidden).toEqual(['x-secret']);
    expect(listing.defaultModel).toBe('x-sol');
    expect(listing.effortsByModel).toEqual({ 'x-sol': ['low', 'medium'], 'x-luna': ['xhigh'] });
    expect(listing.upgrades).toEqual({ 'x-luna': 'x-sol' });
  });

  it('cursor repetido ou páginas demais é lista parcial: falha em vez de virar a verdade', async () => {
    const loop = fakeRpc({
      '': { data: [row('x-a')], nextCursor: 'again' },
      again: { data: [row('x-b')], nextCursor: 'again' },
    });
    await expect(requestAllCodexModels(loop)).rejects.toThrow(/cursor repetido/);
    const endless = fakeRpc(Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [index === 0 ? '' : `c${index}`, { data: [row(`x-${index}`)], nextCursor: `c${index + 1}` }]),
    ));
    await expect(requestAllCodexModels(endless, { maxPages: 3 })).rejects.toThrow(/páginas demais/);
  });

  it('resposta fora do schema não vira listagem', async () => {
    await expect(requestAllCodexModels(fakeRpc({ '': { data: [{ hidden: false }] } }))).rejects.toThrow();
    await expect(requestAllCodexModels(fakeRpc({ '': {} }))).rejects.toThrow();
  });

  it('conta sem login no CODEX_HOME não lista', () => {
    expect(codexAccountRequiresLogin({ account: null, requiresOpenaiAuth: true })).toBe(true);
    expect(codexAccountRequiresLogin({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false })).toBe(false);
    expect(codexAccountRequiresLogin({ account: { type: 'apiKey' } })).toBe(false);
  });
});
