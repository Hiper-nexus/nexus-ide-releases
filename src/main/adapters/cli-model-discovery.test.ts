import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';
import {
  CLI_MODEL_CACHE_SOURCES,
  applyDiscoveredModelsToAdapter,
  applyDiscoveredEffortsToAdapter,
  discoverCliModels,
  readCliEfforts,
  readCliModelCache,
} from './cli-model-discovery';

describe('CLI model discovery', () => {
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

  it('adds live models without deleting configured models', () => {
    const adapter = {
      id: 'codex',
      models: { default: 'gpt-old', list: ['gpt-old'] },
    } as Adapter;
    const next = applyDiscoveredModelsToAdapter(
      adapter,
      new Map([['codex', ['gpt-old', 'gpt-new']]]),
    );
    expect(next.models.list).toEqual(['gpt-old', 'gpt-new']);
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
});
