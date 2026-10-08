import { describe, expect, it } from 'vitest';
import { modelListAuthority, resolveOfferedModels } from './model-availability';

// Regra do T3 (docs/internals/model-manifest.md): nomes sintéticos, para que
// acrescentar um modelo de verdade nunca exija mexer neste teste.
const STATIC = ['x-a', 'x-ghost'];

describe('F-964 resolveOfferedModels — listagem viva autoritativa', () => {
  it('fantasma do estático vira unverified: não é oferecido nem roteado', () => {
    const offer = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      staticDefault: 'x-a',
      live: { status: 'ok', models: ['x-a', 'x-b'], lastGood: ['x-a', 'x-b'] },
    });
    expect(offer.source).toBe('live');
    expect(offer.offered).toEqual(['x-a', 'x-b']);
    expect(offer.routable).toEqual(['x-a', 'x-b']);
    expect(offer.unverified).toEqual(['x-ghost']);
    expect(offer.proof).toEqual({ 'x-a': 'live', 'x-b': 'live' });
    expect(offer.defaultModel).toBe('x-a');
  });

  it('o catálogo só classifica: id só do catálogo vira unverified', () => {
    const input = {
      authority: 'live' as const,
      staticIds: STATIC,
      catalogIds: ['x-a', 'x-blog-only'],
      catalogDefault: 'x-blog-only',
      live: { status: 'ok' as const, models: ['x-a'] },
    };
    const offer = resolveOfferedModels(input);
    expect(offer.offered).toEqual(['x-a']);
    expect(offer.unverified).toEqual(['x-ghost', 'x-blog-only']);
    // Default do catálogo fora da oferta nunca vira default do pane: vale o do
    // adapter; sem ele, '' (a CLI abre no próprio default).
    expect(offer.defaultModel).toBe('');
    expect(resolveOfferedModels({ ...input, staticDefault: 'x-a' }).defaultModel).toBe('x-a');
  });

  it('listagem vazia vinda com sucesso limpa: só os custom do operador', () => {
    const offer = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      staticDefault: 'x-a',
      customIds: ['x-mine'],
      live: { status: 'ok', models: [], lastGood: ['x-a'] },
    });
    expect(offer.offered).toEqual(['x-mine']);
    expect(offer.routable).toEqual([]);
    expect(offer.unverified).toEqual(['x-a', 'x-ghost']);
    expect(offer.proof).toEqual({ 'x-mine': 'custom' });
    expect(offer.defaultModel).toBe('');
  });

  it('falha mantém a última listagem boa (não volta ao estático)', () => {
    const offer = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      customIds: ['x-mine'],
      live: { status: 'failed', models: ['x-a', 'x-b'], lastGood: ['x-a', 'x-b'] },
    });
    expect(offer.source).toBe('last-good');
    expect(offer.offered).toEqual(['x-a', 'x-b', 'x-mine']);
    expect(offer.routable).toEqual(['x-a', 'x-b']);
    expect(offer.unverified).toEqual(['x-ghost']);
    expect(offer.proof['x-b']).toBe('last-good');
  });

  it('sem nenhuma listagem: cache oficial da CLI; sem cache, o contrato bundled', () => {
    const fromCache = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      cacheIds: ['x-a', 'x-cached'],
      live: { status: 'failed', models: [] },
    });
    expect(fromCache.source).toBe('cache');
    expect(fromCache.offered).toEqual(['x-a', 'x-cached']);

    const bundled = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      staticDefault: 'x-a',
      catalogIds: ['x-blog-only'],
      live: { status: 'absent', models: [] },
    });
    expect(bundled.source).toBe('bundled');
    expect(bundled.offered).toEqual(STATIC);
    expect(bundled.routable).toEqual(STATIC);
    expect(bundled.unverified).toEqual(['x-blog-only']);
    expect(bundled.defaultModel).toBe('x-a');
  });

  it('custom do operador é oferecido mas nunca entra na rota automática', () => {
    const offer = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      customIds: ['x-mine', 'x-a'],
      live: { status: 'ok', models: ['x-a'] },
    });
    expect(offer.offered).toEqual(['x-a', 'x-mine']);
    expect(offer.routable).toEqual(['x-a']);
    expect(offer.proof).toEqual({ 'x-a': 'live', 'x-mine': 'custom' });
  });

  it('listagem com rótulos e nenhum id conhecido é parse quebrado, não catálogo (F-958)', () => {
    const offer = resolveOfferedModels({
      authority: 'live',
      staticIds: STATIC,
      live: { status: 'ok', models: ['Label', 'Other'] },
    });
    expect(offer.source).toBe('bundled');
    expect(offer.offered).toEqual(STATIC);
  });

  it('default: catálogo → adapter → o que a CLI marcou → mais novo da linha → vazio', () => {
    const live = { status: 'ok' as const, models: ['x-1.0', 'x-2.0', 'x-cli'], defaultModel: 'x-cli' };
    expect(resolveOfferedModels({ authority: 'live', staticIds: ['x-1.0'], catalogDefault: 'x-2.0', staticDefault: 'x-1.0', live }).defaultModel).toBe('x-2.0');
    expect(resolveOfferedModels({ authority: 'live', staticIds: ['x-1.0'], staticDefault: 'x-1.0', live }).defaultModel).toBe('x-1.0');
    expect(resolveOfferedModels({ authority: 'live', staticIds: ['x-1.0'], staticDefault: 'x-0.9', live }).defaultModel).toBe('x-cli');
    expect(resolveOfferedModels({
      authority: 'live', staticIds: ['x-1.0'], staticDefault: 'x-1.0',
      live: { status: 'ok', models: ['x-2.0', 'y-1'] },
    }).defaultModel).toBe('x-2.0');
    expect(resolveOfferedModels({
      authority: 'live', staticIds: ['x-1.0'], staticDefault: 'x-1.0',
      live: { status: 'ok', models: ['x-1.0', 'y-1'] },
      isBlocked: (model) => model === 'x-1.0',
    }).defaultModel).toBe('');
  });

  it('CLI sem listagem (bundled) mantém a união e o catálogo acrescenta ids', () => {
    const offer = resolveOfferedModels({
      authority: 'bundled',
      staticIds: ['x-a'],
      staticDefault: 'x-a',
      catalogIds: ['x-new'],
      catalogDefault: 'x-new',
      cacheIds: ['x-cache'],
      customIds: ['x-mine'],
    });
    expect(offer.offered).toEqual(['x-a', 'x-cache', 'x-new', 'x-mine']);
    expect(offer.routable).toEqual(offer.offered);
    expect(offer.unverified).toEqual([]);
    expect(offer.defaultModel).toBe('x-new');
  });

  it('autoridade por CLI: listagem viva, cache por versão ou bundled', () => {
    for (const id of ['agy', 'codex', 'kimi', 'opencode', 'cursor-agent', 'mimo-code', 'qoder', 'prime-agent', 'omp']) {
      expect(modelListAuthority(id)).toBe('live');
    }
    expect(modelListAuthority('grok')).toBe('version-cache');
    for (const id of ['claude', 'openclaude', 'glm', 'deepseek', 'qwen', 'plugin-desconhecido']) {
      expect(modelListAuthority(id)).toBe('bundled');
    }
  });
});
