import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from '../memory/workspace-memory';
import {
  getSearchMixer,
  promoteBestHit,
  resetSearchMixerForTests,
  runSearchMixerQuery,
} from './search-mixer-bootstrap';

const roots: string[] = [];

afterEach(() => {
  resetSearchMixerForTests();
  disposeWorkspaceMemoryStores();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('search mixer bootstrap', () => {
  it('registers ripgrep files AND shallow workspaces without overwrite', () => {
    const mixer = getSearchMixer();
    expect(mixer).toBe(getSearchMixer());
    // Critical: one provider per source key — shallow must not clobber ripgrep.
    const sources = mixer.sources();
    expect(sources).toContain('files');
    expect(sources).toContain('workspaces');
    expect(sources).toContain('missions');
    expect(sources).toContain('skills');
    // uniqueness
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('isolates mixers per workspace root (no cross-cancel)', () => {
    const a = getSearchMixer('/ws-a');
    const b = getSearchMixer('/ws-b');
    expect(a).not.toBe(b);
    expect(getSearchMixer('/ws-a')).toBe(a);
  });

  it('returns empty when flag off; runs when flag on', async () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, false);
    const off = await runSearchMixerQuery({ text: 'x', limit: 5 });
    expect(off.hits).toEqual([]);
    expect(off.generation).toBe(0);

    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const on = await runSearchMixerQuery({ text: 'x', limit: 5 });
    // generation advances on live mixer searchNow
    expect(on.generation).toBeGreaterThan(0);
  });

  // F-1003: o mixer da raiz autorizada registrava o ripgrep sem allowedRoots
  // e o "Missing = deny" do 464dbcf00 zerava toda busca no conteúdo (⇧⌘F).
  it('finds file content inside the authorized workspace root (⇧⌘F)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-content-'));
    roots.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'cart.ts'),
      'export function useCoupon() {\n  return "coupon-aplicado";\n}\n',
    );
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);

    const result = await runSearchMixerQuery({
      text: 'coupon-aplicado',
      sources: ['files'],
      limit: 10,
      projectRoot,
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        source: 'files',
        title: 'cart.ts',
        meta: expect.objectContaining({ line: 2 }),
      }),
    ]);
    expect(fs.realpathSync(result.hits[0]!.path!)).toBe(
      fs.realpathSync(path.join(projectRoot, 'src', 'cart.ts')),
    );
  });

  it('keeps the fail-closed default: the root-less mixer never searches files', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-rootless-'));
    roots.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'segredo-fora-da-raiz\n');
    const hits = await getSearchMixer()
      .searchNow({ text: 'segredo-fora-da-raiz', sources: ['files'], limit: 5, projectRoot })
      .then((r) => r.hits);
    expect(hits).toEqual([]);
    // O mixer de uma raiz não autoriza outra (irmã fora dela).
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-other-'));
    roots.push(other);
    const crossed = await getSearchMixer(other)
      .searchNow({ text: 'segredo-fora-da-raiz', sources: ['files'], limit: 5, projectRoot })
      .then((r) => r.hits);
    expect(crossed).toEqual([]);
  });

  it('searches mission notes from the external canonical projection', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-memory-db-'));
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-search-memory-project-'),
    );
    roots.push(baseDir, projectRoot);
    configureWorkspaceMemory({ baseDir });
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.searchMixer, true);
    const store = getWorkspaceMemoryStore({
      version: 1,
      installationId: 'installation-search',
      projectId: 'project-search-memory',
      checkoutId: 'checkout-search',
      rootRealPath: projectRoot,
      identitySource: 'manifest',
    });
    store.retain({
      content: '# Mission Checkout Clean\n\nProjection lives outside Git.',
      kind: 'fact',
      // Forma real que tools-memory.defaultSource emite (e que
      // agentAuthoredSourceSchema exige): sha256 da autoridade física do pane.
      // O texto livre anterior nunca sairia da produção, e aceitá-lo era o que
      // deixava qualquer `source` contendo `mission:` entrar nesta busca.
      source: `agent-authored:mission:${'c1ea4'.repeat(12)}abcd`,
    });

    const result = await runSearchMixerQuery({
      text: 'Checkout Clean',
      sources: ['missions'],
      limit: 5,
      projectRoot,
      workspaceId: 'project-search-memory',
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        source: 'missions',
        title: 'Mission Checkout Clean',
      }),
    ]);
    expect(result.hits[0]).not.toHaveProperty('path');
    // A busca lê a projeção canônica em userData. A cópia legível na pasta do
    // projeto é OPT-IN do operador (F-806), desligada por padrão: um retain
    // nunca cria `.nexus-memory/` no checkout por conta própria.
    await store.flushProjections();
    expect(fs.existsSync(path.join(projectRoot, '.nexus-memory'))).toBe(false);
  });
});

describe('promoteBestHit', () => {
  const hits = [
    { id: 'h1', source: 'files' as const, title: 'primeiro', score: 0.9 },
    { id: 'h2', source: 'missions' as const, title: 'segundo', score: 0.8 },
    { id: 'h3', source: 'files' as const, title: 'terceiro', score: 0.7 },
  ];

  it('move o hit escolhido para o topo preservando a ordem relativa', () => {
    const promoted = promoteBestHit(hits, 'h2');
    expect(promoted.map((h) => h.id)).toEqual(['h2', 'h1', 'h3']);
    // Mesmos elementos
    expect(promoted.map((h) => h.id).sort()).toEqual(['h1', 'h2', 'h3']);
  });

  it('bestHitId null ou ID ausente → hits inalterados', () => {
    // null bestHitId não é passado — a função nunca recebe string vazia/null.
    // ID não encontrado nos hits.
    const unchanged = promoteBestHit(hits, 'h99');
    expect(unchanged.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);
  });

  it('bestHitId já no topo → hits inalterados', () => {
    const unchanged = promoteBestHit(hits, 'h1');
    expect(unchanged.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);
  });
});
