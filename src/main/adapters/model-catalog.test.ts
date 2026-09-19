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
  modelRoutingRankWithAuth,
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
  auth: { method: 'api_key', envVarFallback: 'XAI_API_KEY' },
  spawn: {
    interactive: ['grok'],
    headless: ['grok', '-p', '{{PROMPT}}'],
    ptyRequired: true,
    resumeArgs: [],
    extraArgs: [],
  },
  env: { static: {}, passthrough: ['XAI_API_KEY'], ephemeralHome: false },
  models: { flag: '--model', list: ['grok-4-fast'], default: 'grok-4-fast' },
  promptInjection: { method: 'arg', trailingNewline: false, bracketedPaste: false },
  stateParsing: {
    idle: { type: 'timeout', ms: 800 },
    shellIntegration: false,
    exitCodes: {},
  },
  quirks: {
    altScreen: true,
    requiresNoAutoUpdate: true,
    mcpAutoload: false,
    nexusMcp: 'none',
  },
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

  it('tira da rota automática o modelo sem auth pronta, sem mexer no rank com auth', () => {
    const free = { id: 'm', availability: 'free' } as const;
    expect(modelRoutingRankWithAuth(free, false)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(modelRoutingRankWithAuth(free, true)).toBe(
      modelRoutingRank(free),
    );
    expect(modelRoutingRankWithAuth(null, true)).toBe(
      modelRoutingRank(null),
    );
  });
});

describe('published catalog JSON', () => {
  it('ships Claude Opus 5 and grok-4.5, and marks claude-fable-5 as api-only/high', () => {
    expect(PUBLISHED_MODEL_CATALOG.version).toBe(1);
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'claude', 'claude-opus-5'),
    ).toMatchObject({
      id: 'claude-opus-5',
      availability: 'paid',
      costTier: 'high',
    });
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

  it('keeps any shipped quality block well-formed (no fixture scores)', () => {
    // Fixture scores were removed from resources/model-catalog.json: quality
    // only ships again when a REAL nexus-eval run is published. Whenever a
    // block exists, it must satisfy the safeModels contract.
    for (const adapter of Object.values(PUBLISHED_MODEL_CATALOG.adapters ?? {})) {
      for (const model of adapter.models ?? []) {
        if (!model.quality) continue;
        expect(model.quality.overall).toBeGreaterThan(0);
        expect(model.quality.overall).toBeLessThanOrEqual(100);
        expect(model.quality.source).toMatch(/^nexus-eval\//);
        expect(Number.isNaN(Date.parse(model.quality.evaluatedAt))).toBe(false);
      }
    }
  });

  it('ships GLM-5.3 as the z.ai default and keeps 5.2 selectable', () => {
    const glm = PUBLISHED_MODEL_CATALOG.adapters?.glm;
    const ids = glm?.models?.map((model) => model.id) ?? [];

    expect(glm?.default).toBe('glm-5.3');
    expect(ids).toEqual(
      expect.arrayContaining(['glm-5.3', 'glm-5.2', 'glm-4.7']),
    );
  });

  it('ships glm-5.3-flash (2026-08-26) and claude-fable-5-1/mythos-5-1 (2026-09-01)', () => {
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      expect(
        modelCatalogInfo(catalog, 'glm', 'glm-5.3-flash'),
      ).toMatchObject({
        id: 'glm-5.3-flash',
        availability: 'cheap',
        costTier: 'low',
      });
      expect(
        modelCatalogInfo(catalog, 'claude', 'claude-fable-5-1'),
      ).toMatchObject({
        id: 'claude-fable-5-1',
        availability: 'paid',
        costTier: 'high',
      });
      const mythos = modelCatalogInfo(catalog, 'claude', 'claude-mythos-5-1');
      expect(mythos?.availability).toBe('api-only');
      expect(isModelBlockedForAutoRouting(mythos)).toBe(true);
    }
    // Fable 5.1 é GA: participa do roteamento automático.
    expect(
      isModelBlockedForAutoRouting(
        modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'claude', 'claude-fable-5-1'),
      ),
    ).toBe(false);
  });

  it('ships gpt-6-astra (2026-09-03) como trusted-access, fora do roteamento automático', () => {
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      const astra = modelCatalogInfo(catalog, 'codex', 'gpt-6-astra');
      expect(astra?.availability).toBe('api-only');
      expect(astra?.costTier).toBe('high');
      expect(isModelBlockedForAutoRouting(astra)).toBe(true);
    }
    // O rollout restrito não vira default, mas o melhor modelo GA vira.
    expect(BUILTIN_MODEL_CATALOG.adapters?.codex?.default).toBe(
      'gpt-5.6-sol',
    );
    expect(PUBLISHED_MODEL_CATALOG.adapters?.codex?.default).toBe(
      'gpt-5.6-sol',
    );
  });

  it('keeps the AGY published default on the newest pro generation (3.8 high)', () => {
    const agy = PUBLISHED_MODEL_CATALOG.adapters?.agy;
    const ids = agy?.models?.map((model) => model.id) ?? [];

    // Doutrina do produto: o agy abre sempre na geração mais recente
    // com reasoning high — 3.8 flash high hoje (gemini-3.8-pro não existe).
    expect(agy?.default).toBe('gemini-3.8-flash-high');
    expect(ids).toEqual(
      expect.arrayContaining([
        'gemini-3.8-flash-high',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-low',
        'gemini-3.7-flash-high',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-low',
        'gemini-3.6-flash-high',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-low',
      ]),
    );
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'agy', 'gemini-3.7-flash-high'),
    ).toMatchObject({
      id: 'gemini-3.7-flash-high',
      availability: 'cheap',
      costTier: 'low',
    });
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'agy', 'gemini-3.7-flash-high')
        ?.quality,
    ).toBeUndefined();
    expect(BUILTIN_MODEL_CATALOG.adapters?.agy?.default).toBe(
      'gemini-3.8-flash-high',
    );
    expect(
      modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'agy', 'gemini-3.8-flash-high')?.id,
    ).toBe('gemini-3.8-flash-high');
  });
});

describe('loadModelCatalog quality merge layer', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('keeps nexus-eval quality when a cost-only legacy overlay merges on top', () => {
    // A regra mora em mergeModelCatalogs: entry de overlay sem quality não
    // pode apagar a quality da base. Base sintética — o catálogo publicado
    // não carrega mais notas de fixture.
    const base = {
      version: 1,
      adapters: {
        claude: {
          models: [
            {
              id: 'claude-opus-4-8',
              availability: 'paid' as const,
              costTier: 'high' as const,
              source: 'nexus-eval',
              quality: {
                overall: 61,
                coding: 63,
                security: 62,
                evaluatedAt: '2026-07-11T21:00:00.000Z',
                source: 'nexus-eval/v1/test',
              },
            },
          ],
        },
      },
    };
    const legacyOverlay = {
      adapters: {
        claude: {
          models: [
            {
              id: 'claude-opus-4-8',
              availability: 'paid' as const,
              costTier: 'high' as const,
              source: 'local',
            },
          ],
        },
      },
    };

    const merged = mergeModelCatalogs(base, legacyOverlay);
    const opus = modelCatalogInfo(merged, 'claude', 'claude-opus-4-8');
    expect(opus?.source).toBe('local');
    expect(opus?.quality?.source).toMatch(/^nexus-eval\//);
    expect(opus?.quality?.overall).toBeGreaterThan(0);
    expect(opus?.quality?.security).toBeDefined();
  });

  it('passes well-formed quality through the on-disk normalizer and drops malformed blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        adapters: {
          local: {
            models: [
              {
                id: 'well-formed',
                quality: {
                  overall: 70,
                  evaluatedAt: '2026-07-11T21:00:00.000Z',
                  source: 'nexus-eval/v1/test',
                },
              },
              {
                id: 'bad-source',
                quality: {
                  overall: 70,
                  evaluatedAt: '2026-07-11T21:00:00.000Z',
                  source: 'manual-scrape',
                },
              },
              {
                id: 'out-of-range',
                quality: {
                  overall: 140,
                  evaluatedAt: '2026-07-11T21:00:00.000Z',
                  source: 'nexus-eval/v1/test',
                },
              },
            ],
          },
        },
      }),
    );

    invalidateModelCatalogCache();
    const catalog = loadModelCatalog(file);
    expect(modelCatalogInfo(catalog, 'local', 'well-formed')?.quality?.overall).toBe(70);
    expect(modelCatalogInfo(catalog, 'local', 'bad-source')?.quality).toBeUndefined();
    expect(modelCatalogInfo(catalog, 'local', 'out-of-range')?.quality).toBeUndefined();
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
    expect(modelCatalogInfo(catalog, 'glm', 'glm-5.3')?.availability).toBe(
      'cheap',
    );
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
