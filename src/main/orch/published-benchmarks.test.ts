import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import {
  PUBLISHED_BENCHMARKS,
  publishedBenchmarkFor,
  publishedBenchmarkKey,
  publishedCodingQuality,
} from './published-benchmarks';
import { DEFAULT_ROUTING_TABLE } from './task-router';

/** Linhas da tabela sem número oficial publicado pelo fabricante (não se inventa nota). */
const UNPUBLISHED_ROUTE_MODELS = new Set([
  'mimo-code:xiaomi/mimo-v2.6-pro-ultraspeed',
  'opencode:opencode/deepseek-v4-flash',
  'opencode:openrouter/anthropic/claude-sonnet-5',
  'opencode:openrouter/anthropic/claude-opus-4.8',
  'openclaude:haiku',
  'openclaude:sonnet',
  'openclaude:opus',
  'aider:claude-haiku-4-5',
  'aider:claude-sonnet-5',
  'aider:claude-opus-4-8',
]);

describe('benchmarks oficiais publicados (F-675)', () => {
  it('toda chave aponta para um modelo do catálogo builtin', () => {
    const reachable = new Set(
      Object.entries(BUILTIN_MODEL_CATALOG.adapters ?? {}).flatMap(([adapterId, entry]) =>
        (entry.models ?? []).map(m => publishedBenchmarkKey(adapterId, m.id))),
    );
    const dangling = Object.keys(PUBLISHED_BENCHMARKS).filter(key => !reachable.has(key));
    expect(dangling).toEqual([]);
  });

  it('toda entrada tem fonte e sameModelAs resolve para uma entrada com número', () => {
    for (const [key, entry] of Object.entries(PUBLISHED_BENCHMARKS)) {
      expect(entry.source.length, key).toBeGreaterThan(0);
      if (entry.sameModelAs) {
        expect(PUBLISHED_BENCHMARKS[entry.sameModelAs], key).toBeDefined();
      }
    }
  });

  it('toda linha da tabela de rota tem nota oficial ou está listada como sem publicação', () => {
    const missing: string[] = [];
    for (const rows of Object.values(DEFAULT_ROUTING_TABLE)) {
      for (const row of rows) {
        if (!row.model) continue;
        const key = `${row.adapterId}:${row.model}`;
        if (publishedCodingQuality(row.adapterId, row.model) === null && !UNPUBLISHED_ROUTE_MODELS.has(key)) {
          missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('normaliza variantes de esforço, contexto e adapters irmãos', () => {
    expect(publishedBenchmarkKey('agy', 'gemini-3.8-flash-high')).toBe('agy:gemini-3.8-flash');
    expect(publishedBenchmarkKey('glm-flash', 'glm-5.3-flash[1m]')).toBe('glm:glm-5.3-flash');
    expect(publishedBenchmarkKey('devin', 'swe-2-max')).toBe('devin:swe-2');
    expect(publishedBenchmarkKey('muse-claude', 'muse-spark-1.3')).toBe('muse:muse-spark-1.3');
  });

  it('variante do mesmo modelo herda o número do base; ultraspeed não herda', () => {
    expect(publishedBenchmarkFor('grok', 'grok-4.7-build-fast')?.deepSWE).toBe(71.0);
    expect(publishedBenchmarkFor('minimax-code', 'minimax/MiniMax-M2.7-highspeed')?.swebenchVerified).toBe(79.9);
    expect(publishedCodingQuality('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')).toBeNull();
    expect(publishedCodingQuality('deepseek', 'deepseek-chat')).toBeNull();
  });

  it('a nota fica na escala 6..24 do pipeline e ordena pelo número publicado', () => {
    const opus = publishedCodingQuality('claude', 'claude-opus-5-5')!;
    const mimo = publishedCodingQuality('mimo-code', 'xiaomi/mimo-v2.6-pro')!;
    const glm52 = publishedCodingQuality('glm', 'glm-5.2')!;
    for (const q of [opus, mimo, glm52]) {
      expect(q).toBeGreaterThanOrEqual(6);
      expect(q).toBeLessThanOrEqual(24);
    }
    expect(mimo).toBeGreaterThan(12);
    expect(glm52).toBeLessThan(mimo);
  });

  it('GPT-6.1 Sol supera o GPT-6 Sol na nota oficial (DeepSWE 75,2 × 68,8)', () => {
    const next = publishedCodingQuality('codex', 'gpt-6.1-sol');
    const sol = publishedCodingQuality('codex', 'gpt-6-sol');
    expect(sol).not.toBeNull();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(sol!);
  });
});
