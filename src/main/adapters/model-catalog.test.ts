import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';
import { adapterSchema } from '../../shared/adapter-types';
import minimaxRaw from '../../adapters/builtin/minimax-code.json';
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
  isStaleUserModelCatalog,
  modelCatalogReferenceErrors,
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
  it('F-1649: offers MiniMax GA as the effective default without retiring M3 or M2.7', () => {
    const raw = adapterSchema.parse(minimaxRaw);
    const missing = path.join(os.tmpdir(), `nexus-no-catalog-${process.pid}-f1649.json`);
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG, loadModelCatalog(missing)]) {
      const adapter = applyModelCatalogToAdapter(raw, catalog);
      expect(adapter.models.default).toBe('minimax/MiniMax-M3.1-Flash');
      expect(adapter.models.list).toEqual([
        'minimax/MiniMax-M3.1-Flash', 'minimax/MiniMax-M3',
        'minimax/MiniMax-M2.7-highspeed', 'minimax/MiniMax-M2.7',
      ]);
      expect(modelCatalogInfo(catalog, 'minimax-code', adapter.models.default)?.quality).toBeUndefined();
    }
  });

  it('F-1649: a stale catalog overlay cannot reintroduce the retired MiniMax Preview default', () => {
    const stale = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, {
      adapters: { 'minimax-code': {
        default: 'minimax/MiniMax-M3.1-Flash-Preview',
        models: [{ id: 'minimax/MiniMax-M3.1-Flash-Preview', source: 'local' }],
      } },
    });
    const adapter = applyModelCatalogToAdapter(adapterSchema.parse(minimaxRaw), stale);
    expect(adapter.models.default).toBe('minimax/MiniMax-M3.1-Flash');
    expect(adapter.models.list).not.toContain('minimax/MiniMax-M3.1-Flash-Preview');
    expect(adapter.models.list).toContain('minimax/MiniMax-M2.7');
  });

  it('CLI sem listagem: o catálogo acrescenta ids sem substituir o JSON do adapter', () => {
    const BUNDLED = { ...ADAPTER, id: 'example-bundled' };
    const merged = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, {
      adapters: {
        'example-bundled': {
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

    const adapter = applyModelCatalogToAdapter(BUNDLED, merged);

    expect(adapter.models.list).toEqual(
      expect.arrayContaining(['grok-4-fast', 'grok-4.5']),
    );
    expect(modelCatalogInfo(merged, 'example-bundled', 'grok-4.5')?.source).toBe('remote');
  });

  it('F-990: CLI que lista (grok, agy, codex…) — o catálogo classifica, nunca acrescenta id', () => {
    const merged = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, {
      adapters: { grok: { default: 'grok-4.5', models: [{ id: 'grok-4.5', availability: 'cheap', source: 'remote' }] } },
    });
    const adapter = applyModelCatalogToAdapter(ADAPTER, merged);
    expect(adapter.models.list).toEqual(['grok-4-fast']);
    // Default do catálogo fora da oferta não move o default (applyManifestDefault).
    expect(adapter.models.default).toBe('grok-4-fast');
    const offered = applyModelCatalogToAdapter({ ...ADAPTER, models: { ...ADAPTER.models, list: ['grok-4-fast', 'grok-4.5'] } }, merged);
    expect(offered.models.default).toBe('grok-4.5');
    const agy = applyModelCatalogToAdapter({ ...ADAPTER, id: 'agy', models: { flag: '--model', list: ['gemini-3.8-flash-high'], default: 'gemini-3.8-flash-high' } }, BUILTIN_MODEL_CATALOG);
    expect(agy.models.list).toEqual(['gemini-3.8-flash-high']);
    expect(modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'agy', 'gemini-4-argon')).not.toBeNull();
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
  it('F-1391: sem cache, o Muse lista os 4 modelos Meta com default muse-wonder-1.0 e esforço por modelo', () => {
    const missing = path.join(os.tmpdir(), `nexus-no-catalog-${process.pid}-f1391.json`);
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG, loadModelCatalog(missing)]) {
      const muse = catalog.adapters?.muse;
      expect(muse?.default).toBe('muse-wonder-1.0');
      expect(muse?.models?.map((m) => m.id)).toEqual([
        'muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2',
      ]);
      for (const id of ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3']) {
        expect(modelCatalogInfo(catalog, 'muse', id)?.efforts).toContain('max');
      }
    }
    // Muse via Claude fica no spark até haver evidência de que o endpoint aceita o wonder.
    expect(PUBLISHED_MODEL_CATALOG.adapters?.['muse-claude']?.default).toBe('muse-spark-1.3');
  });
  it('uses the available Sonnet 5.5 line for a fresh Claude default', () => {
    const original = { ...ADAPTER, id: 'claude', models: {
      flag: '--model', list: ['claude-sonnet-5'], default: 'claude-sonnet-5',
    } };
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      const configured = applyModelCatalogToAdapter(original, catalog);
      expect(configured.models.default).toBe('claude-sonnet-5-5');
      expect(configured.models.list).toContain(configured.models.default);
    }
  });
  it('exposes Sonnet 5.5 through stale catalogs without changing a pinned default', () => {
    const combined = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG);
    const withLocal = mergeModelCatalogs(combined, {
      adapters: { claude: { default: 'claude-sonnet-5', models: [{ id: 'claude-sonnet-5' }] } },
    });
    const adapter = applyModelCatalogToAdapter({ ...ADAPTER, id: 'claude',
      models: { flag: '--model', list: ['claude-sonnet-5'], default: 'claude-sonnet-5' },
    }, withLocal);
    expect(adapter.models.list).toContain('claude-sonnet-5-5');
    expect(adapter.models.default).toBe('claude-sonnet-5');
    const info = modelCatalogInfo(withLocal, 'claude', 'claude-sonnet-5-5');
    expect(info).toMatchObject({ availability: 'paid', costTier: 'medium' });
    expect(info?.warning).toBeUndefined();
    expect(info?.quality).toBeUndefined();
    expect(isModelBlockedForAutoRouting(info)).toBe(false);
  });
  it('offers Grok 4.7 even alongside an older user catalog, preserving explicit defaults', () => {
    const combined = mergeModelCatalogs(PUBLISHED_MODEL_CATALOG, {
      adapters: { grok: { default: 'grok-4.6', models: [{ id: 'grok-4.6', availability: 'paid' }] } },
    });
    // F-990: o grok oferece o que lista; o catálogo só move o default entre esses.
    const GROK = { ...ADAPTER, models: { ...ADAPTER.models, list: ['grok-4.7', 'grok-4.6', 'grok-4-fast'] } };
    const adapter = applyModelCatalogToAdapter(GROK, combined);
    expect(adapter.models.list).toContain('grok-4.7');
    expect(adapter.models.default).toBe('grok-4.6');
    expect(applyModelCatalogToAdapter(GROK, PUBLISHED_MODEL_CATALOG).models.default).toBe('grok-4.7');
    expect(modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'grok', 'grok-4.7')).toMatchObject({ availability: 'paid', costTier: 'high' });
  });
  it('ships Claude Opus 5.5 (replacing Opus 5) and grok-4.5, and marks claude-fable-5 as api-only/high', () => {
    expect(PUBLISHED_MODEL_CATALOG.version).toBe(1);
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'claude', 'claude-opus-5-5'),
    ).toMatchObject({
      id: 'claude-opus-5-5',
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

  it('ships gpt-6.1-sol/sol/luna/astra (2026) como paid — astra saiu do trusted-access', () => {
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      expect(modelCatalogInfo(catalog, 'codex', 'gpt-6.1-sol')).toMatchObject({
        id: 'gpt-6.1-sol',
        availability: 'paid',
        costTier: 'high',
      });
      expect(modelCatalogInfo(catalog, 'codex', 'gpt-6-sol')).toMatchObject({
        id: 'gpt-6-sol',
        availability: 'paid',
        costTier: 'high',
      });
      expect(modelCatalogInfo(catalog, 'codex', 'gpt-6-luna')).toMatchObject({
        id: 'gpt-6-luna',
        availability: 'paid',
        costTier: 'medium',
      });
      const astra = modelCatalogInfo(catalog, 'codex', 'gpt-6-astra');
      // ~/.codex/models_cache.json (2026-09-27) lista o Astra como visível.
      expect(astra?.availability).toBe('paid');
      expect(astra?.costTier).toBe('high');
      expect(isModelBlockedForAutoRouting(astra)).toBe(false);
    }
    // Astra custa 5× o Sol: o default segue no workhorse — hoje o 6.1
    // (docs/models/estudo-2026-09.md).
    expect(BUILTIN_MODEL_CATALOG.adapters?.codex?.default).toBe(
      'gpt-6.1-sol',
    );
    expect(PUBLISHED_MODEL_CATALOG.adapters?.codex?.default).toBe(
      'gpt-6.1-sol',
    );
  });

  it('ships gpt-daybreak-blue-latest from the Codex 0.163.0 cache (2026-10-16)', () => {
    for (const catalog of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      expect(modelCatalogInfo(catalog, 'codex', 'gpt-daybreak-blue-latest')).toMatchObject({
        id: 'gpt-daybreak-blue-latest',
        availability: 'paid',
        costTier: 'high',
      });
    }
    // The Codex evidence remains from 16/10; later updates to other providers
    // must advance the catalog publication date without rewriting that evidence.
    expect(Date.parse(PUBLISHED_MODEL_CATALOG.updatedAt!))
      .toBeGreaterThanOrEqual(Date.parse('2026-10-16T00:00:00.000Z'));
    expect(isModelBlockedForAutoRouting(
      modelCatalogInfo(BUILTIN_MODEL_CATALOG, 'codex', 'gpt-daybreak-blue-latest'),
    )).toBe(false);
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
        'gemini-4-argon-high',
        'gemini-4-argon-medium',
        'gemini-4-argon-low',
      ]),
    );
    expect(ids.some((id) => /^gemini-3\.[67]-flash-/.test(id))).toBe(false);
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'agy', 'gemini-3.8-flash-low'),
    ).toMatchObject({
      id: 'gemini-3.8-flash-low',
      availability: 'cheap',
      costTier: 'low',
    });
    expect(
      modelCatalogInfo(PUBLISHED_MODEL_CATALOG, 'agy', 'gemini-3.8-flash-low')
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

  it('catálogo do usuário mais velho que o publicado não sobrescreve o app (F-679)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-catalog-'));
    tmpDirs.push(dir);
    const published = PUBLISHED_MODEL_CATALOG.adapters?.agy?.models?.find(
      (m) => m.id === 'gemini-3.8-flash-high',
    );
    expect(published?.costTier).toBe('high');
    let written = 0;
    const write = (updatedAt: string | undefined) => {
      written += 1;
      const file = path.join(dir, `catalog-${written}.json`);
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        ...(updatedAt ? { updatedAt } : {}),
        adapters: {
          agy: {
            models: [
              { id: 'gemini-3.8-flash-high', availability: 'cheap', costTier: 'low' },
              { id: 'gemini-local-only', availability: 'free', costTier: 'free' },
            ],
          },
        },
      }));
      return file;
    };
    const agy = (file: string, id: string) =>
      loadModelCatalog(file).adapters?.agy?.models?.find((m) => m.id === id);

    // Semente de 14/09 (campo, 29/09): o app de 28/09 vence; o modelo que só o
    // usuário conhece continua disponível.
    const stale = write('2026-09-03T00:00:00.000Z');
    expect(isStaleUserModelCatalog(JSON.parse(fs.readFileSync(stale, 'utf8')))).toBe(true);
    expect(agy(stale, 'gemini-3.8-flash-high')?.costTier).toBe('high');
    expect(agy(stale, 'gemini-local-only')?.costTier).toBe('free');

    // Catálogo mais novo que o app, ou sem data (edição manual): o usuário manda.
    expect(agy(write('2999-01-01T00:00:00.000Z'), 'gemini-3.8-flash-high')?.costTier).toBe('low');
    expect(agy(write(undefined), 'gemini-3.8-flash-high')?.costTier).toBe('low');
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

  it('falls back to the public release mirror catalog branch', () => {
    expect(resolveModelCatalogUrl({})).toBe(DEFAULT_MODEL_CATALOG_URL);
    expect(DEFAULT_MODEL_CATALOG_URL).toBe(
      'https://raw.githubusercontent.com/Hiper-nexus/nexus-ide-releases/catalog/resources/model-catalog.json',
    );
  });

  it('accepts a local absolute path via the env var (as file://)', () => {
    const nativePath = process.platform === 'win32'
      ? 'C:\\Users\\me\\dev\\nexus-ide\\resources\\model-catalog.json'
      : '/Users/me/dev/nexus-ide/resources/model-catalog.json';
    const expectedUrl = process.platform === 'win32'
      ? 'file:///C:/Users/me/dev/nexus-ide/resources/model-catalog.json'
      : 'file:///Users/me/dev/nexus-ide/resources/model-catalog.json';
    expect(
      resolveModelCatalogUrl({
        [MODEL_CATALOG_URL_ENV]: nativePath,
      }),
    ).toBe(expectedUrl);
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

    // F-679: catálogo remoto mais velho que o publicado do app perde para ele;
    // aqui o remoto é o mais novo, então sobrepõe o que o app traz.
    const remoteBody = {
      version: 2,
      updatedAt: '2099-01-01T00:00:00.000Z',
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
      return new Response(JSON.stringify(remoteBody));
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

  it('preserves a newer existing overlay when the default URL fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    const local = {
      version: 9,
      updatedAt: '2099-01-01T00:00:00.000Z',
      adapters: {
        grok: {
          models: [{ id: 'grok-4.7', availability: 'free', costTier: 'free' }],
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n');
    const before = fs.readFileSync(file);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));

    expect(await refreshRemoteModelCatalog(DEFAULT_MODEL_CATALOG_URL, file)).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(modelCatalogInfo(loadModelCatalog(file), 'grok', 'grok-4.7')).toMatchObject({
      availability: 'free', costTier: 'free',
    });
  });

  it('allows a cold connection ten seconds, then aborts without replacing an existing overlay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    const before = JSON.stringify({ version: 9, adapters: {} });
    fs.writeFileSync(file, before);
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
    }));
    vi.useFakeTimers();
    try {
      const pending = refreshRemoteModelCatalog(DEFAULT_MODEL_CATALOG_URL, file);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestSignal?.aborted).toBe(true);
      expect(await pending).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      vi.useRealTimers();
    }
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

  it('F-990 (PRV-10): default fora da lista ou id duplicado — remoto rejeitado, a última versão boa fica', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    const lastGood = JSON.stringify({ version: 1, updatedAt: '2026-10-01T00:00:00.000Z', adapters: {
      'x-cli': { default: 'x-a', models: [{ id: 'x-a' }] },
    } });
    fs.writeFileSync(file, lastGood);
    for (const remote of [
      { version: 1, updatedAt: '2099-01-01T00:00:00.000Z', adapters: { 'x-cli': { default: 'x-ghost', models: [{ id: 'x-a' }] } } },
      { version: 1, updatedAt: '2099-01-01T00:00:00.000Z', adapters: { 'x-cli': { default: 'x-a', models: [{ id: 'x-a' }, { id: 'x-a' }] } } },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(remote))));
      expect(await refreshRemoteModelCatalog('https://example.test/catalog.json', file)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(lastGood);
    }
    expect(modelCatalogReferenceErrors({ adapters: { 'x-cli': { default: 'x-ghost', models: [{ id: 'x-a' }] } } }))
      .toEqual(['x-cli: default "x-ghost" fora da lista']);
    expect(modelCatalogReferenceErrors({ adapters: { 'x-cli': { models: [{ id: 'x-a' }, { id: 'x-a' }] } } }))
      .toEqual(['x-cli: id duplicado "x-a"']);
  });

  it('F-990 (PRV-10): edição remota mais velha que a do disco não substitui', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    const current = JSON.stringify({ version: 1, updatedAt: '2026-10-07T00:00:00.000Z', adapters: { 'x-cli': { models: [{ id: 'x-new' }] } } });
    fs.writeFileSync(file, current);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      version: 1, updatedAt: '2026-10-01T00:00:00.000Z', adapters: { 'x-cli': { models: [{ id: 'x-old' }] } },
    }))));
    expect(await refreshRemoteModelCatalog('https://example.test/catalog.json', file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(current);
  });

  it('F-990 (PRV-10): os catálogos que o app traz passam na validação referencial', () => {
    expect(modelCatalogReferenceErrors(PUBLISHED_MODEL_CATALOG)).toEqual([]);
    expect(modelCatalogReferenceErrors(BUILTIN_MODEL_CATALOG)).toEqual([]);
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

describe('maxContext enrichment (F-912)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('preenche a janela a partir do catálogo vendorado e deixa ausente quem não tem fonte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-max-context-'));
    tmpDirs.push(dir);
    const catalog = loadModelCatalog(path.join(dir, 'model-catalog.json'));
    // anthropic/claude-sonnet-5-5 e zai/glm-5.3 têm contextWindow no recorte
    // vendorado (src/vendor/omp/catalog/models-rich.json).
    expect(modelCatalogInfo(catalog, 'claude', 'claude-sonnet-5-5')?.maxContext).toBe(1_000_000);
    expect(modelCatalogInfo(catalog, 'glm', 'glm-5.3')?.maxContext).toBe(1_000_000);
    // grok-4.7 não está no recorte xai: sem número inventado, o campo fica
    // ausente (fail-open do filtro do roteador).
    const grokInfo = modelCatalogInfo(catalog, 'grok', 'grok-4.7');
    expect(grokInfo).not.toBeNull();
    expect(grokInfo?.maxContext).toBeUndefined();
  });

  it('valor explícito do overlay do usuário vence o preenchimento vendorado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-max-context-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        adapters: {
          claude: {
            models: [
              {
                id: 'claude-sonnet-5-5',
                availability: 'paid',
                costTier: 'medium',
                source: 'local',
                maxContext: 123_456,
              },
            ],
          },
        },
      }),
    );
    const catalog = loadModelCatalog(file);
    expect(modelCatalogInfo(catalog, 'claude', 'claude-sonnet-5-5')?.maxContext).toBe(123_456);
  });
});

describe('F-1412: visão por modelo no catálogo', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('GLM 5.3 Flash tem visão; GLM 5.3 (mais capaz, lento) não declara visão', () => {
    const missing = path.join(os.tmpdir(), `nexus-no-catalog-${process.pid}-f1412.json`);
    invalidateModelCatalogCache();
    const catalog = loadModelCatalog(missing);
    expect(modelCatalogInfo(catalog, 'glm-flash', 'glm-5.3-flash[1m]')?.vision).toBe(true);
    expect(modelCatalogInfo(catalog, 'glm-flash', 'glm-5.3-flash')?.vision).toBe(true);
    expect(modelCatalogInfo(catalog, 'glm', 'glm-5.3')?.vision).toBeUndefined();
  });

  it('overlay só afirma visão: vision:false do usuário não apaga a do Flash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        adapters: {
          'glm-flash': {
            models: [
              { id: 'glm-5.3-flash[1m]', availability: 'cheap', costTier: 'low', source: 'local', vision: false },
            ],
          },
          glm: {
            models: [
              { id: 'glm-5.3', availability: 'cheap', costTier: 'low', source: 'local', vision: 'yes' },
            ],
          },
        },
      }),
    );
    invalidateModelCatalogCache();
    const catalog = loadModelCatalog(file);
    expect(modelCatalogInfo(catalog, 'glm-flash', 'glm-5.3-flash[1m]')?.vision).toBe(true);
    expect(modelCatalogInfo(catalog, 'glm', 'glm-5.3')?.vision).toBeUndefined();
  });
});
