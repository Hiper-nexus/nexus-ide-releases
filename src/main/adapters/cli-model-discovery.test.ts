import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adapterSchema, type Adapter } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import {
  CLI_MODEL_CACHE_SOURCES,
  applyDiscoveredModelsToAdapter,
  applyDiscoveredEffortsToAdapter,
  discoverCliEfforts,
  discoverCliEffortsAsync,
  discoverCliModels,
  discoverCliModelsAndEfforts,
  discoverCliModelsAndEffortsAsync,
  discoverCliModelsAsync,
  museModelCatalogSource,
  readMuseContributorConsent,
  readCliEfforts,
  readCliModelCache,
  readCliModelCacheAsync,
} from './cli-model-discovery';

describe('CLI model discovery', () => {
  it('periodic cache reads are async and still refuse newer producer offers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'async-cli-cache-'));
    const file = path.join(root, 'models.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ client_version: '3.0.0', models: [{ id: 'future-model' }] }));
      const pending = readCliModelCacheAsync(file, { clientVersion: '2.0.0' });
      expect(pending).toBeInstanceOf(Promise);
      expect(await pending).toEqual([]);
      expect(await readCliModelCacheAsync(file, { clientVersion: '3.0.0' })).toEqual(['future-model']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('F-724: catálogo vivo do Qwen Code traz o deepseek-v4-pro só no Token Plan', () => {
    const qwen = CLI_MODEL_CACHE_SOURCES.find((source) => source.adapterId === 'qwen')!;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-models-qwen-'));
    const file = path.join(home, '.qwen', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    vi.stubEnv('QWEN_HOME', path.dirname(file));
    try {
      const write = (baseUrl: string) => fs.writeFileSync(file, JSON.stringify({
        modelProviders: { openai: [{ id: 'qwen3.8-max' }, { id: 'deepseek-v4-flash' }] },
        security: { auth: { selectedType: 'openai', baseUrl } },
      }));
      write('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
      expect(discoverCliModels([{ ...qwen, files: [file] }]).get('qwen'))
        .toEqual(['qwen3.8-max', 'deepseek-v4-pro']);
      write('https://dashscope.aliyuncs.com/compatible-mode/v1');
      expect(discoverCliModels([{ ...qwen, files: [file] }]).get('qwen'))
        .toEqual(['qwen3.8-max']);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads official cache rows and ignores hidden/invalid identifiers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-models-'));
    const file = path.join(dir, 'models_cache.json');
    fs.writeFileSync(file, JSON.stringify({ models: [
      { slug: 'gpt-5.6-sol', visibility: 'list' },
      { id: 'provider/model-new' },
      { slug: 'hidden-model', visibility: 'hidden' },
      { id: 'not a model id' },
    ] }));
    expect(readCliModelCache(file)).toEqual(['gpt-5.6-sol', 'provider/model-new']);
  });

  it('rejects models and efforts produced by a newer CLI than the resolved installation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-provenance-'));
    const file = path.join(dir, 'models_cache.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ client_version: '0.160.0', models: [{
        slug: 'future-model', supported_reasoning_levels: [{ effort: 'ultra' }],
      }] }));
      expect(readCliModelCache(file, { clientVersion: '0.146.0' })).toEqual([]);
      expect(readCliEfforts(file, { clientVersion: '0.146.0' })).toEqual([]);
      expect(readCliModelCache(file, { clientVersion: '0.160.0' })).toEqual(['future-model']);
      expect(readCliEfforts(file, { clientVersion: '0.161.0' })).toEqual(['ultra']);
      expect(readCliModelCache(file, { clientVersion: null })).toEqual([]);
      expect(discoverCliModels([{ adapterId: 'codex', files: [file], clientVersion: () => '0.146.0' }]).has('codex')).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not treat malformed producer metadata as a current CLI offer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-provenance-'));
    const file = path.join(dir, 'models_cache.json');
    try {
      for (const client_version of ['not-a-version', 160, '', null]) {
        fs.writeFileSync(file, JSON.stringify({ client_version, models: [{ slug: 'future-model' }] }));
        expect(readCliModelCache(file, { clientVersion: '0.160.0' })).toEqual([]);
      }
      fs.writeFileSync(file, JSON.stringify({ models: [{ slug: 'legacy-model' }] }));
      expect(readCliModelCache(file)).toEqual(['legacy-model']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('lê os aliases do config.toml do Kimi Code como lista oficial', () => {
    // Kimi Code 2.x não tem models_cache.json: `--model` aceita só os aliases
    // de [models."…"]; sem esta fonte a lista vinha do bundled velho (kimi-k2.7).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-models-'));
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, [
      'default_model = "kimi-code/k3"',
      '[models."kimi-code/k3"]',
      'model = "k3"',
      '[models."kimi-code/kimi-for-coding"]',
      '[providers."kimi-code"]',
    ].join('\n'));
    expect(readCliModelCache(file)).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding']);
    expect(discoverCliModels([{ adapterId: 'kimi', files: [file] }]).get('kimi'))
      .toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding']);
  });

  it('merges multiple cache files for every registered adapter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-models-'));
    const one = path.join(dir, 'one.json');
    const two = path.join(dir, 'two.json');
    fs.writeFileSync(one, JSON.stringify({ models: [{ slug: 'model-a' }] }));
    fs.writeFileSync(two, JSON.stringify([{ id: 'model-b' }]));
    expect(discoverCliModels([{ adapterId: 'any-cli', files: [one, two] }]).get('any-cli'))
      .toEqual(['model-a', 'model-b']);
  });

  it('reads map caches with nested provider info', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-models-'));
    const file = path.join(dir, 'models_cache.json');
    fs.writeFileSync(file, JSON.stringify({ models: {
      'grok-4.5': { info: { id: 'grok-4.5', hidden: false } },
      secret: { info: { id: 'grok-secret', hidden: true } },
    } }));
    expect(readCliModelCache(file)).toEqual(['grok-4.5']);
  });

  it('adds live models without deleting configured models (CLI sem listagem)', () => {
    const adapter = {
      id: 'claude',
      models: { default: 'claude-old', list: ['claude-old'] },
    } as Adapter;
    const next = applyDiscoveredModelsToAdapter(
      adapter,
      new Map([['claude', ['claude-old', 'claude-new']]]),
    );
    expect(next.models.list).toEqual(['claude-old', 'claude-new']);
  });

  it('F-990: CLI que lista não ganha união — a oferta sai do resolvedor', () => {
    for (const id of ['codex', 'agy', 'grok']) {
      const adapter = { id, models: { default: 'x-old', list: ['x-old', 'x-ghost'] } } as Adapter;
      expect(applyDiscoveredModelsToAdapter(adapter, new Map([[id, ['x-old', 'x-new']]]))).toBe(adapter);
    }
  });

  it('discovers every reasoning effort advertised by the CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-efforts-'));
    const file = path.join(dir, 'models_cache.json');
    fs.writeFileSync(file, JSON.stringify({ models: [{
      slug: 'gpt-next',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'xhigh' }, { effort: 'ultra' },
      ],
    }] }));
    expect(readCliEfforts(file)).toEqual(['low', 'xhigh', 'ultra']);
  });

  it('merges live efforts into the adapter capability', () => {
    const adapter = {
      kind: 'cli-pty', id: 'codex',
      control: { effort: { arg: '-c', levels: ['high'] } },
    } as Adapter;
    const next = applyDiscoveredEffortsToAdapter(
      adapter,
      new Map([['codex', ['high', 'ultra']]]),
    );
    expect(next.kind === 'cli-pty' && next.control?.effort?.levels)
      .toEqual(['high', 'ultra']);
  });

  it('reads each CLI cache file once to extract both models and efforts in the same pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-single-pass-'));
    const codexFile = path.join(dir, 'models_cache.json');
    const kimiFile = path.join(dir, 'config.toml');
    const museDir = path.join(dir, 'muse');
    const museSettings = path.join(dir, 'muse-settings.json');
    fs.mkdirSync(museDir, { recursive: true });
    try {
      fs.writeFileSync(codexFile, JSON.stringify({
        client_version: '0.160.0',
        models: [
          { slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
          { id: 'gpt-hidden', visibility: 'hidden', supported_reasoning_levels: ['max'] },
        ],
      }));
      fs.writeFileSync(kimiFile, '[models."kimi-code/k3"]\nmodel = "k3"\n');
      fs.writeFileSync(path.join(museDir, 'cat.json'), JSON.stringify({
        rows: [museRow('muse-spark-1.3', 'visible', ['low', 'high'])],
      }));
      fs.writeFileSync(museSettings, JSON.stringify({}));

      let versionChecks = 0;
      const sources = [
        {
          adapterId: 'codex',
          files: [codexFile],
          clientVersion: () => {
            versionChecks += 1;
            return '0.160.0';
          },
        },
        { adapterId: 'kimi', files: [kimiFile] },
        museModelCatalogSource(museDir, museSettings),
      ];

      const openSpy = vi.spyOn(fs, 'openSync');
      try {
        const syncResult = discoverCliModelsAndEfforts(sources);
        expect(syncResult.models.get('codex')).toEqual(['gpt-5.6-sol']);
        expect(syncResult.efforts.get('codex')).toEqual(['low', 'xhigh', 'max']);
        expect(syncResult.models.get('kimi')).toEqual(['kimi-code/k3']);
        expect(syncResult.efforts.has('kimi')).toBe(false);
        expect(syncResult.models.get('muse')).toEqual(['muse-spark-1.3']);
        expect(syncResult.efforts.get('muse')).toContain('high');
        expect(versionChecks).toBe(1);
        const openedFiles = openSpy.mock.calls.map((call) => String(call[0]));
        expect(openedFiles.filter((f) => f === codexFile)).toHaveLength(1);
        expect(openedFiles.filter((f) => f === kimiFile)).toHaveLength(1);
        expect(openedFiles.filter((f) => f === museSettings)).toHaveLength(1);
        expect(openedFiles.filter((f) => f === path.join(museDir, 'cat.json'))).toHaveLength(1);
      } finally {
        openSpy.mockRestore();
      }

      versionChecks = 0;
      const asyncResult = await discoverCliModelsAndEffortsAsync(sources);
      expect(asyncResult.models.get('codex')).toEqual(['gpt-5.6-sol']);
      expect(asyncResult.efforts.get('codex')).toEqual(['low', 'xhigh', 'max']);
      expect(asyncResult.models.get('kimi')).toEqual(['kimi-code/k3']);
      expect(asyncResult.models.get('muse')).toEqual(['muse-spark-1.3']);
      expect(asyncResult.efforts.get('muse')).toContain('high');
      expect(versionChecks).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// F-1391: recorte fiel do cache real do Muse 1.4.6 (12/10/2026,
// ~/.local/share/muse/model-catalog/6d657461__p746268.json), só os campos lidos.
const MUSE_TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const museRow = (model_id: string, visibility: string, tiers: string[], extra: object = {}) => ({
  model_id, display_label: model_id, provider_id: 'meta', profile_id: 'tbh', visibility,
  is_default: false, is_current: false, context_limit: 1007997, output_limit: 128000,
  reasoning_effort_variants: tiers.map((tier) => ({ tier, description: null })),
  supports_video: false, supports_image_generation: false, ...extra,
});
const MUSE_CATALOG = {
  schema_version: 2, provider_id: 'meta', profile_id: 'tbh', source: 'provider_catalog',
  rows: [
    museRow('muse-wonder-1.0', 'visible', MUSE_TIERS, { is_default: true }),
    museRow('muse-wonder-1.0-contributor', 'hidden', MUSE_TIERS),
    museRow('muse-wonder-full-1.0', 'visible', MUSE_TIERS),
    museRow('muse-wonder-full-1.0-contributor', 'hidden', MUSE_TIERS),
    museRow('muse-spark-1.3', 'visible', [...MUSE_TIERS, 'max'], { is_current: true }),
    museRow('muse-spark-1.3-contributor', 'hidden', [...MUSE_TIERS, 'max']),
    { ...museRow('muse-image-1.0', 'hidden', []), reasoning_effort_variants: null, supports_image_generation: true },
    museRow('muse-spark-1.2', 'visible', MUSE_TIERS),
    museRow('muse-spark-1.2-contributor', 'hidden', MUSE_TIERS),
  ],
};

describe('catálogo dinâmico do Muse (F-1391)', () => {
  const withCatalog = async (files: Record<string, string>, run: (dir: string) => Promise<void> | void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-catalog-'));
    try {
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      await run(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const museAdapter = (): Adapter => adapterSchema.parse(
    BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'muse'),
  );

  it('oferece só as linhas visible — sem -contributor, sem muse-image, sem hidden', async () => {
    await withCatalog({ '6d657461__p746268.json': JSON.stringify(MUSE_CATALOG) }, async (dir) => {
      const source = museModelCatalogSource(dir, path.join(dir, 'settings.json'));
      const expected = ['muse-wonder-1.0', 'muse-wonder-full-1.0', 'muse-spark-1.3', 'muse-spark-1.2'];
      expect(discoverCliModels([source]).get('muse')).toEqual(expected);
      expect((await discoverCliModelsAsync([source])).get('muse')).toEqual(expected);
    });
  });

  it('modelo novo do cache vira modelo do adapter muse; o default estático fica', async () => {
    const next = {
      ...MUSE_CATALOG,
      rows: [...MUSE_CATALOG.rows, museRow('muse-wonder-1.1', 'visible', MUSE_TIERS), museRow('muse-wonder-1.1-contributor', 'visible', MUSE_TIERS)],
    };
    await withCatalog({ 'a.json': JSON.stringify(next) }, (dir) => {
      const adapter = applyDiscoveredModelsToAdapter(museAdapter(), discoverCliModels([museModelCatalogSource(dir, path.join(dir, 'settings.json'))]));
      expect(adapter.models.list).toContain('muse-wonder-1.1');
      expect(adapter.models.list).not.toContain('muse-wonder-1.1-contributor');
      expect(adapter.models.list.some((id) => id.startsWith('muse-image'))).toBe(false);
      expect(adapter.models.default).toBe('muse-wonder-1.0');
    });
  });

  it('F-1398: cache desatualizado não retira max aceito pelo adapter Muse', async () => {
    await withCatalog({ '6d657461__p746268.json': JSON.stringify(MUSE_CATALOG) }, async (dir) => {
      const source = museModelCatalogSource(dir, path.join(dir, 'settings.json'));
      expect(discoverCliEfforts([source]).get('muse')).toEqual([...MUSE_TIERS, 'max']);
      expect((await discoverCliEffortsAsync([source])).get('muse')).toEqual([...MUSE_TIERS, 'max']);
      const adapter = applyDiscoveredEffortsToAdapter(museAdapter(), discoverCliEfforts([source]));
      expect(adapter.kind === 'cli-pty' ? adapter.control?.effort?.levels : []).toContain('max');
    });
  });

  it('diretório ausente, JSON ilegível ou sem rows → nada (fica o catálogo estático)', async () => {
    const missingDir = path.join(os.tmpdir(), `nexus-muse-missing-${process.pid}`);
    const missing = museModelCatalogSource(missingDir, path.join(missingDir, 'settings.json'));
    expect(discoverCliModels([missing]).has('muse')).toBe(false);
    expect((await discoverCliModelsAsync([missing])).has('muse')).toBe(false);
    expect(discoverCliEfforts([missing]).has('muse')).toBe(false);
    await withCatalog({ 'bad.json': '{nope', 'other.json': JSON.stringify({ models: [{ id: 'x' }] }), 'notes.txt': 'muse-wonder-9' }, async (dir) => {
      const source = museModelCatalogSource(dir, path.join(dir, 'settings.json'));
      expect(discoverCliModels([source]).has('muse')).toBe(false);
      expect((await discoverCliModelsAsync([source])).has('muse')).toBe(false);
    });
  });

  it.each([
    { model: 'muse-wonder-1.0-contributor' },
    { model_reasoning_efforts: { 'muse-wonder-full-1.0-contributor': 'xhigh' } },
  ])('F-1398: consentimento em settings %j oferece contributor oculto nos leitores sync e async', async (settings) => {
    await withCatalog({ 'catalog.json': JSON.stringify(MUSE_CATALOG), 'settings.json': JSON.stringify(settings) }, async (dir) => {
      const settingsFile = path.join(dir, 'settings.json');
      expect(readMuseContributorConsent(settingsFile)).toBe(true);
      const source = museModelCatalogSource(dir, settingsFile);
      const sync = discoverCliModels([source]).get('muse');
      expect(sync).toContain('muse-wonder-1.0-contributor');
      expect(sync).toContain('muse-wonder-full-1.0-contributor');
      expect(sync).not.toContain('muse-image-1.0');
      expect((await discoverCliModelsAsync([source])).get('muse')).toEqual(sync);
    });
  });

  it.each(['{bad', 'null', '{}', JSON.stringify({ model: 'muse-wonder-full-1.0' }),
    JSON.stringify({ model_reasoning_efforts: { 'muse-wonder-1.0': 'max' } }),
  ])('F-1398: settings inválido ou sem opt-in (%s) nega consentimento', async (settings) => {
    await withCatalog({ 'catalog.json': JSON.stringify(MUSE_CATALOG), 'settings.json': settings }, async (dir) => {
      const source = museModelCatalogSource(dir, path.join(dir, 'settings.json'));
      expect(readMuseContributorConsent(path.join(dir, 'settings.json'))).toBe(false);
      expect(discoverCliModels([source]).get('muse')?.some((id) => id.endsWith('-contributor'))).toBe(false);
      expect((await discoverCliModelsAsync([source])).get('muse')?.some((id) => id.endsWith('-contributor'))).toBe(false);
    });
  });

  it('F-1398: settings ausente nega consentimento e não herda o HOME real do operador', async () => {
    await withCatalog({ 'catalog.json': JSON.stringify(MUSE_CATALOG) }, async (dir) => {
      const settingsFile = path.join(dir, 'missing-settings.json');
      expect(readMuseContributorConsent(settingsFile)).toBe(false);
      const source = museModelCatalogSource(dir, settingsFile);
      expect(discoverCliModels([source]).get('muse')?.some((id) => id.endsWith('-contributor'))).toBe(false);
      expect((await discoverCliModelsAsync([source])).get('muse')?.some((id) => id.endsWith('-contributor'))).toBe(false);
    });
  });

  it('F-1398: esforços do Wonder Full unem cache antigo ao suporte estático de max', async () => {
    await withCatalog({ 'catalog.json': JSON.stringify({ rows: [museRow('muse-wonder-full-1.0', 'visible', MUSE_TIERS)] }) }, async (dir) => {
      const source = museModelCatalogSource(dir, path.join(dir, 'missing-settings.json'));
      expect(discoverCliEfforts([source]).get('muse')).toContain('max');
      expect((await discoverCliEffortsAsync([source])).get('muse')).toContain('max');
    });
  });

  it('a fonte embutida lê o cache do HOME do processo Main, como os caches do Codex/Grok', () => {
    const muse = CLI_MODEL_CACHE_SOURCES.find((source) => source.adapterId === 'muse');
    expect(muse?.files).toEqual([path.join(os.homedir(), '.local', 'share', 'muse', 'model-catalog', '*.json')]);
  });
});
