import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';
import {
  applyDiscoveredModelsToAdapter,
  applyDiscoveredEffortsToAdapter,
  discoverCliModels,
  readCliEfforts,
  readCliModelCache,
} from './cli-model-discovery';

describe('CLI model discovery', () => {
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
