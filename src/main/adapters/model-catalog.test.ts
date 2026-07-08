import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';
import {
  BUILTIN_MODEL_CATALOG,
  DEFAULT_MODEL_CATALOG_URL,
  MODEL_CATALOG_URL_ENV,
  PUBLISHED_MODEL_CATALOG,
  applyModelCatalogToAdapter,
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  mergeModelCatalogs,
  modelCatalogInfo,
  modelRoutingRank,
  refreshRemoteModelCatalog,
  resolveModelCatalogUrl,
  seedLocalModelCatalogFromPublished,
  invalidateModelCatalogCache,
} from './model-catalog';

const ADAPTER: Adapter = {
  kind: 'cli-pty',
  id: 'grok',
  label: 'Grok',
  version: '1.0.0',
  icon: 'X',
  bin: 'grok',
  detect: 'grok --version',
  install: { method: 'npm', command: 'npm i -g grok' },
  auth: { method: 'api_key', envVarFallback: 'GROK_API_KEY' },
  spawn: {
    interactive: ['grok'],
    headless: ['grok', '-p', '{{PROMPT}}'],
    ptyRequired: true,
    resumeArgs: [],
    extraArgs: [],
  },
  env: { static: {}, passthrough: ['GROK_API_KEY'], ephemeralHome: false },
  models: { flag: '--model', list: ['grok-4-fast'], default: 'grok-4-fast' },
  promptInjection: { method: 'arg', trailingNewline: false, bracketedPaste: false },
  stateParsing: {
    idle: { type: 'timeout', ms: 800 },
    shellIntegration: false,
    exitCodes: {},
  },
  quirks: { altScreen: true, requiresNoAutoUpdate: true, mcpAutoload: false },
  control: {},
};

describe('model catalog overlays', () => {
  it('adds newly shipped models without replacing the adapter JSON', () => {
    const merged = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, {
      adapters: {
        grok: {
          models: [
            {
              id: 'grok-4.5',
              availability: 'cheap',
              costTier: 'low',
              source: 'remote',
            },
          ],
        },
      },
    });

    const adapter = applyModelCatalogToAdapter(ADAPTER, merged);

    expect(adapter.models.list).toEqual(
      expect.arrayContaining(['grok-4-fast', 'grok-4.5']),
    );
    expect(modelCatalogInfo(merged, 'grok', 'grok-4.5')?.source).toBe('remote');
  });

  it('marks API-only models as blocked for automatic routing', () => {
    const info = modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'claude', 'claude-fable-5');

    expect(info?.availability).toBe('api-only');
    expect(isModelBlockedForAutoRouting(info)).toBe(true);
  });

  it('does not treat partial paid metadata as cheaper than paid medium metadata', () => {
    const partialPaid = modelRoutingRank({ id: 'x', availability: 'paid' });
    const paidMedium = modelRoutingRank({
      id: 'y',
      availability: 'paid',
      costTier: 'medium',
    });

    expect(partialPaid).toBeGreaterThanOrEqual(paidMedium);
  });
});

describe('published catalog JSON', () => {
  it('ships grok-4.5 and marks claude-fable-5 as api-only/high', () => {
    expect(PUBLISHED_MODEL_CATALOG.version).toBe(1);
    expect(modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'grok', 'grok-4.5')?.id).toBe(
      'grok-4.5',
    );
    const fable = modelCatalogInfo(
      PUBLISHED_MODEL_CATALOG,
      'claude',
      'claude-fable-5',
    );
    expect(fable?.availability).toBe('api-only');
    expect(fable?.costTier).toBe('high');
    expect(isModelBlockedForAutoRouting(fable)).toBe(true);
  });
});

describe('remote model catalog URL', () => {
  it('uses NEXUS_MODEL_CATALOG_URL when set', () => {
    expect(
      resolveModelCatalogUrl({
        [MODEL_CATALOG_URL_ENV]: 'https://example.test/catalog.json',
      }),
    ).toBe('https://example.test/catalog.json');
  });

  it('falls back to the published GitHub raw default', () => {
    expect(resolveModelCatalogUrl({})).toBe(DEFAULT_MODEL_CATALOG_URL);
    expect(DEFAULT_MODEL_CATALOG_URL).toContain(
      'raw.githubusercontent.com/cleofasvolarehost/nexus-ide/catalog/resources/model-catalog.json',
    );
  });

  it('accepts a local absolute path via the env var (as file://)', () => {
    expect(
      resolveModelCatalogUrl({
        [MODEL_CATALOG_URL_ENV]: '/Users/me/dev/nexus-ide/resources/model-catalog.json',
      }),
    ).toBe('file:///Users/me/dev/nexus-ide/resources/model-catalog.json');
  });
});

describe('refreshRemoteModelCatalog', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('fetches remote JSON, writes local overlay, and merges over builtins', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');

    const remoteBody = {
      version: 2,
      updatedAt: '2026-07-08T00:00:00.000Z',
      adapters: {
        grok: {
          models: [
            {
              id: 'grok-4.5',
              availability: 'cheap',
              costTier: 'low',
              warning: 'promo window',
            },
          ],
        },
        claude: {
          models: [
            {
              id: 'claude-fable-5',
              availability: 'api-only',
              costTier: 'high',
            },
          ],
        },
      },
    };

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://example.test/remote-catalog.json');
      return {
        ok: true,
        json: async () => remoteBody,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await refreshRemoteModelCatalog(
      'https://example.test/remote-catalog.json',
      file,
    );
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(true);

    invalidateModelCatalogCache();
    const catalog = loadModelCatalog(file);
    expect(modelCatalogInfo(catalog, 'grok', 'grok-4.5')?.source).toBe('remote');
    expect(modelCatalogInfo(catalog, 'grok', 'grok-4.5')?.availability).toBe(
      'cheap',
    );
    expect(modelCatalogInfo(catalog, 'claude', 'claude-fable-5')?.availability).toBe(
      'api-only',
    );
    // Builtin entries for other adapters still present after merge.
    expect(modelCatalogInfo(catalog, 'glm', 'glm-5.2')?.availability).toBe(
      'cheap',
    );
  });

  it('loads from a local absolute path without fetch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const source = path.join(dir, 'source.json');
    const dest = path.join(dir, 'model-catalog.json');
    fs.writeFileSync(
      source,
      JSON.stringify({
        version: 9,
        adapters: {
          grok: {
            models: [
              { id: 'grok-4.5', availability: 'paid', costTier: 'high' },
            ],
          },
        },
      }),
    );

    const ok = await refreshRemoteModelCatalog(source, dest);
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(dest, 'utf8'));
    expect(written.version).toBe(9);
    expect(written.adapters.grok.models[0].id).toBe('grok-4.5');
  });

  it('falls back to the bundled published catalog when the default URL fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const ok = await refreshRemoteModelCatalog(DEFAULT_MODEL_CATALOG_URL, file);
    expect(ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.adapters.claude.models.some((m: { id: string }) => m.id === 'claude-fable-5')).toBe(
      true,
    );
    expect(written.adapters.grok.models.some((m: { id: string }) => m.id === 'grok-4.5')).toBe(
      true,
    );
  });

  it('returns false when a non-default fetch fails without writing a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const ok = await refreshRemoteModelCatalog(
      'https://example.test/down.json',
      file,
    );
    expect(ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('seeds a missing local overlay from the published catalog', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');

    expect(seedLocalModelCatalogFromPublished(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    // Second call is a no-op unless force=true.
    expect(seedLocalModelCatalogFromPublished(file)).toBe(false);
    expect(seedLocalModelCatalogFromPublished(file, true)).toBe(true);
  });
});
